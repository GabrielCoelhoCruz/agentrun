import { NodeServices } from "@effect/platform-node"
import { describe, it } from "@effect/vitest"
import { Console, DateTime, Deferred, Duration, Effect, Exit, Fiber, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { RunState } from "../src/domain/RunState.js"
import { Task, TaskId } from "../src/domain/Task.js"
import type { TaskStatus } from "../src/domain/TaskStatus.js"
import { Worktrees } from "../src/Worktrees.js"
import type { Worktree } from "../src/Worktrees.js"

const task = (id = "fix-login") =>
  new Task({
    id: Schema.decodeSync(TaskId)(id),
    title: "Fix login",
    prompt: "Fix login.",
    agent: "claude-code",
    stallTimeout: Duration.minutes(5),
    maxDuration: Duration.minutes(60),
  })

const git = Effect.fn("test.git")(function*(cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }))
  const [stdout, stderr, exitCode] = yield* Effect.all([
    handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
    handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    handle.exitCode,
  ], { concurrency: "unbounded" })
  assert.strictEqual(exitCode, 0, `git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}, Effect.scoped)

interface Fixture {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly repoRoot: string
  readonly home: string
  readonly baseSha: string
  readonly runId: string
}

const withRepo = Effect.fn("test.withRepo")(
  function*<E, R>(
    test: (fixture: Fixture) => Effect.Effect<void, E, R>,
    permits = 1,
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-repo-" })
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-home-" })
    yield* git(repoRoot, ["init", "-b", "main"])
    yield* git(repoRoot, ["config", "commit.gpgsign", "false"])
    yield* fs.writeFileString(path.join(repoRoot, "tracked.txt"), "original\n")
    yield* git(repoRoot, ["add", "tracked.txt"])
    yield* git(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "Initial"])
    const baseSha = yield* git(repoRoot, ["rev-parse", "main"])
    const runId = "20261003T1200-a1b2"
    yield* test({ fs, path, repoRoot, home, baseSha, runId }).pipe(
      Effect.provide(Worktrees.layer({ repoRoot, home, runId, permits })),
    )
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
)

const state = (fixture: Fixture, worktree: Worktree, status: TaskStatus) =>
  new RunState({
    version: 1,
    runId: fixture.runId,
    repoRoot: fixture.repoRoot,
    base: "main",
    baseSha: fixture.baseSha,
    concurrency: 2,
    tasks: [task()],
    status: { [worktree.taskId]: status },
    worktrees: { [worktree.taskId]: { path: worktree.path, branch: worktree.branch, pgid: 12345 } },
  })

const edit = Effect.fn("test.edit")(function*(fixture: Fixture, worktree: Worktree) {
  yield* fixture.fs.writeFileString(fixture.path.join(worktree.path, "new.txt"), "new content\n")
  yield* fixture.fs.writeFileString(fixture.path.join(worktree.path, "tracked.txt"), "tracked edit\n")
})

const parallel = Effect.fn("test.parallel")(function*(fixture: Fixture) {
  const service = yield* Worktrees
  const worktrees = yield* Effect.all([
    service.acquire(task("first-task"), fixture.baseSha),
    service.acquire(task("second-task"), fixture.baseSha),
  ], { concurrency: 2 })
  assert.strictEqual(worktrees.length, 2)
  for (const worktree of worktrees) {
    assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
    assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
  }
})

describe("Worktrees", () => {
  it.live("creates the deterministic directory and branch from baseSha", () =>
    withRepo((fixture) =>
      Effect.scoped(Effect.gen(function*() {
        const service = yield* Worktrees
        const located = service.locate(task().id)
        const commonDir = yield* git(fixture.repoRoot, ["rev-parse", "--git-common-dir"])
        const realPath = yield* fixture.fs.realPath(fixture.path.resolve(fixture.repoRoot, commonDir))
        const repoHash = createHash("sha256").update(realPath).digest("hex").slice(0, 12)
        assert.deepStrictEqual(located, {
          taskId: task().id,
          path: fixture.path.join(fixture.home, ".agentrun", "worktrees", repoHash, fixture.runId, task().id),
          branch: "agentrun/fix-login-a1b2",
        })
        const worktree = yield* service.acquire(task(), fixture.baseSha)
        assert.deepStrictEqual(worktree, located)
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
        assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
      }))
    ))

  it.live("removes the directory on success and keeps the branch", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = yield* Effect.scoped(service.acquire(task(), fixture.baseSha))
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
        assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
        yield* Effect.scoped(Effect.gen(function*() {
          const reused = yield* service.acquire(task(), "unused-base-sha")
          assert.deepStrictEqual(reused, worktree)
          assert.strictEqual(yield* git(reused.path, ["rev-parse", "HEAD"]), fixture.baseSha)
        }))
      })
    ))

  it.live("keeps the directory and branch on interruption", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const acquired = yield* Deferred.make<Worktree>()
        const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
          const worktree = yield* service.acquire(task(), fixture.baseSha)
          yield* Deferred.succeed(acquired, worktree)
          return yield* Effect.never
        })))
        const worktree = yield* Deferred.await(acquired)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        assert.strictEqual(Exit.hasInterrupts(exit), true)
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
        assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
      })
    ))

  it.live("keeps a dirty directory without failing scope close", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = yield* Effect.scoped(Effect.gen(function*() {
          const worktree = yield* service.acquire(task(), fixture.baseSha)
          yield* fixture.fs.writeFileString(fixture.path.join(worktree.path, "untracked.txt"), "keep me\n")
          return worktree
        }))
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
        assert.strictEqual(
          yield* fixture.fs.readFileString(fixture.path.join(worktree.path, "untracked.txt")),
          "keep me\n",
        )
      })
    ))

  it.live("commits new and tracked files and returns false when clean", () =>
    withRepo((fixture) =>
      Effect.scoped(Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = yield* service.acquire(task(), fixture.baseSha)
        yield* edit(fixture, worktree)
        assert.strictEqual(yield* service.commit(worktree, "Save deliverable"), true)
        assert.strictEqual(yield* git(fixture.repoRoot, ["show", `${worktree.branch}:new.txt`]), "new content")
        assert.strictEqual(yield* git(fixture.repoRoot, ["show", `${worktree.branch}:tracked.txt`]), "tracked edit")
        assert.strictEqual(
          yield* git(worktree.path, ["log", "-1", "--format=%an <%ae> %s"]),
          "agentrun <agentrun@localhost> Save deliverable",
        )
        assert.strictEqual(yield* service.commit(worktree, "No changes"), false)
      }))
    ))

  it.live("diff includes committed new content and the tracked edit", () =>
    withRepo((fixture) =>
      Effect.scoped(Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = yield* service.acquire(task(), fixture.baseSha)
        yield* edit(fixture, worktree)
        yield* service.commit(worktree, "Save deliverable")
        const diff = Buffer.from(yield* service.diff(worktree, fixture.baseSha)).toString("utf8")
        assert.ok(diff.includes("+new content"))
        assert.ok(diff.includes("+tracked edit"))
        assert.ok(diff.includes("diff --git a/new.txt b/new.txt"))
      }))
    ))

  it.live("acquires two directories and branches concurrently", () =>
    withRepo((fixture) => Effect.scoped(parallel(fixture))))

  it.live("records ten concurrent acquisitions with two permits", () =>
    Effect.gen(function*() {
      const failures: Array<{ iteration: number; stderr: string }> = []
      for (let iteration = 1; iteration <= 10; iteration++) {
        yield* withRepo((fixture) =>
          Effect.scoped(Effect.gen(function*() {
            const service = yield* Worktrees
            yield* Effect.all([
              service.acquire(task("first-task"), fixture.baseSha),
              service.acquire(task("second-task"), fixture.baseSha),
            ], { concurrency: 2 })
          })).pipe(
            Effect.catchTag("GitError", (error) =>
              Effect.sync(() => {
                failures.push({ iteration, stderr: error.stderr })
              })),
          ), 2)
      }
      yield* Console.log(
        "Two-permit acquisitions",
        JSON.stringify({ iterations: 10, failed: failures.length, failures }),
      )
    }), 30000)

  const rows: ReadonlyArray<{
    readonly name: string
    readonly status: TaskStatus
    readonly dir: boolean
    readonly branch: boolean
    readonly dirty?: boolean
    readonly action: string
  }> = [
    { name: "pending without leftovers", status: { _tag: "pending" }, dir: false, branch: false, action: "Nothing" },
    {
      name: "pending with branch only",
      status: { _tag: "pending" },
      dir: false,
      branch: true,
      action: "RemovedIntent",
    },
    {
      name: "pending with directory and branch",
      status: { _tag: "pending" },
      dir: true,
      branch: true,
      action: "RemovedIntent",
    },
    {
      name: "pending with dirty directory",
      status: { _tag: "pending" },
      dir: true,
      branch: true,
      dirty: true,
      action: "RemoveFailed",
    },
    {
      name: "running with directory and branch",
      status: { _tag: "running", attempt: 1, startedAt: DateTime.makeUnsafe("2026-10-03T12:00:00Z") },
      dir: true,
      branch: true,
      action: "Interrupted",
    },
    {
      name: "running without directory",
      status: { _tag: "running", attempt: 1, startedAt: DateTime.makeUnsafe("2026-10-03T12:00:00Z") },
      dir: false,
      branch: true,
      action: "WorktreeMissing",
    },
    {
      name: "running without directory or branch",
      status: { _tag: "running", attempt: 1, startedAt: DateTime.makeUnsafe("2026-10-03T12:00:00Z") },
      dir: false,
      branch: false,
      action: "WorktreeMissing",
    },
    {
      name: "interrupted with directory",
      status: { _tag: "interrupted", attempt: 1 },
      dir: true,
      branch: true,
      action: "Resumable",
    },
    {
      name: "interrupted with branch only",
      status: { _tag: "interrupted", attempt: 1 },
      dir: false,
      branch: true,
      action: "Recreated",
    },
    {
      name: "succeeded with clean directory",
      status: { _tag: "succeeded", durationMs: 1 },
      dir: true,
      branch: true,
      action: "Removed",
    },
    {
      name: "succeeded with dirty directory",
      status: { _tag: "succeeded", durationMs: 1 },
      dir: true,
      branch: true,
      dirty: true,
      action: "RemoveFailed",
    },
    {
      name: "failed with clean directory",
      status: { _tag: "failed", attempt: 1, reason: "failed" },
      dir: true,
      branch: true,
      action: "Removed",
    },
    {
      name: "failed with dirty directory",
      status: { _tag: "failed", attempt: 1, reason: "failed" },
      dir: true,
      branch: true,
      dirty: true,
      action: "RemoveFailed",
    },
  ]

  for (const row of rows) {
    it.live(`reconciles ${row.name}`, () =>
      withRepo((fixture) =>
        Effect.gen(function*() {
          const service = yield* Worktrees
          const worktree = service.locate(task().id)
          if (row.branch) {
            yield* Effect.scoped(Effect.gen(function*() {
              yield* (yield* Worktrees).acquire(task(), fixture.baseSha)
            })).pipe(Effect.provide(Worktrees.layer({ ...fixture, keepWorktrees: true })))
            if (!row.dir) yield* fixture.fs.remove(worktree.path, { recursive: true })
            if (row.dirty) yield* edit(fixture, worktree)
          }
          const recorded = state(fixture, worktree, row.status)
          const before = JSON.stringify(recorded)
          const actions = yield* service.reconcile(recorded)
          assert.strictEqual(actions.length, 1)
          const action = actions[0]
          assert.ok(action)
          assert.strictEqual(action._tag, row.action)
          assert.strictEqual(action.taskId, worktree.taskId)
          assert.strictEqual(JSON.stringify(recorded), before)
          const kept = ["Interrupted", "Resumable", "Recreated", "RemoveFailed"].includes(row.action)
          assert.strictEqual(yield* fixture.fs.exists(worktree.path), kept)
          if (action._tag === "RemoveFailed") {
            assert.ok(action.stderr.includes("modified or untracked files"))
            assert.strictEqual(
              yield* fixture.fs.readFileString(fixture.path.join(worktree.path, "new.txt")),
              "new content\n",
            )
          }
          if (row.action === "RemovedIntent") {
            const branches = yield* git(fixture.repoRoot, ["branch", "--list", worktree.branch])
            assert.strictEqual(branches, "")
          } else if (row.branch) {
            assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
          }
        })
      ))
  }

  it.live("locate differs across run IDs and stays synchronous", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const first = (yield* Worktrees).locate(task().id)
        const second = yield* Effect.gen(function*() {
          const service = yield* Worktrees
          const located = service.locate(task().id)
          assert.deepStrictEqual(service.locate(task().id), located)
          return located
        }).pipe(Effect.provide(Worktrees.layer({ ...fixture, runId: "20261003T1201-c3d4" })))
        assert.notStrictEqual(first.path, second.path)
        assert.notStrictEqual(first.branch, second.branch)
      })
    ))

  it.live("reports command, exit code and stderr for an invalid baseSha", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = service.locate(task().id)
        const error = yield* Effect.flip(Effect.scoped(service.acquire(task(), "missing-base-sha")))
        assert.strictEqual(error._tag, "GitError")
        assert.strictEqual(error.command, `git worktree add -b ${worktree.branch} ${worktree.path} missing-base-sha`)
        const direct = spawnSync("git", ["worktree", "add", "-b", worktree.branch, worktree.path, "missing-base-sha"], {
          cwd: fixture.repoRoot,
          encoding: "utf8",
        })
        assert.strictEqual(error.exitCode, direct.status)
        assert.strictEqual(error.stderr, direct.stderr)
        assert.ok(error.stderr.includes("missing-base-sha"))
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
      })
    ))
})

for (const resource of ["branch", "directory", "worktree"] as const) {
  it.live(`refuses unrecorded pending ${resource} without cleanup`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = service.locate(task().id)
        if (resource === "branch") yield* git(fixture.repoRoot, ["branch", worktree.branch, fixture.baseSha])
        else {
          yield* fixture.fs.makeDirectory(fixture.path.dirname(worktree.path), { recursive: true })
          if (resource === "worktree") {
            yield* git(fixture.repoRoot, ["worktree", "add", "-b", worktree.branch, worktree.path, fixture.baseSha])
          } else yield* fixture.fs.makeDirectory(worktree.path)
          yield* fixture.fs.writeFileString(fixture.path.join(worktree.path, "owner-file"), "preserve")
        }
        const before = yield* git(fixture.repoRoot, ["show-ref"])
        const unowned = new RunState({ ...state(fixture, worktree, { _tag: "pending" }), worktrees: {} })
        const error = yield* Effect.flip(service.reconcile(unowned))
        assert.strictEqual(error._tag, "GitError")
        assert.match(error.stderr, /[Cc]ollision|[Oo]wnership/)
        assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
        if (resource !== "branch") {
          assert.strictEqual(
            yield* fixture.fs.readFileString(fixture.path.join(worktree.path, "owner-file")),
            "preserve",
          )
        }
      })
    ))
}

it.live("new acquisition refuses an existing branch instead of adopting it", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const service = yield* Worktrees
      const worktree = service.locate(task().id)
      yield* git(fixture.repoRoot, ["branch", worktree.branch, fixture.baseSha])
      const error = yield* Effect.flip(service.acquire(task(), fixture.baseSha))
      assert.strictEqual(error._tag, "GitError")
      assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
    })
  ))

for (const status of ["pending", "interrupted", "failed", "succeeded"] as const) {
  it.live(`ownership refuses legacy ${status} resources with recorded names but no creation proof`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const located = service.locate(task().id)
        yield* git(fixture.repoRoot, ["worktree", "add", "-b", located.branch, located.path, fixture.baseSha])
        yield* fixture.fs.writeFileString(fixture.path.join(located.path, "private-work"), "preserve\n")
        const saved = state(
          fixture,
          located,
          status === "pending"
            ? { _tag: "pending" }
            : status === "interrupted"
            ? { _tag: "interrupted", attempt: 1 }
            : status === "failed"
            ? { _tag: "failed", attempt: 1, reason: "old failure" }
            : { _tag: "succeeded", durationMs: 1 },
        )
        const before = yield* git(fixture.repoRoot, ["show-ref"])
        const error = yield* Effect.flip(service.reconcile(saved))
        assert.strictEqual(error._tag, "GitError")
        assert.match(error.stderr, /[Oo]wnership/)
        assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
        assert.strictEqual(
          yield* fixture.fs.readFileString(fixture.path.join(located.path, "private-work")),
          "preserve\n",
        )
      })
    ))
}

it.live("ownership refuses snapshot and publication through a recorded but foreign workspace", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const service = yield* Worktrees
      const located = service.locate(task().id)
      yield* git(fixture.repoRoot, ["worktree", "add", "-b", located.branch, located.path, fixture.baseSha])
      yield* edit(fixture, located)
      const index = yield* git(located.path, ["diff", "--cached"])
      const before = yield* git(fixture.repoRoot, ["show-ref"])
      const snapshot = yield* Effect.flip(service.snapshot(located, "must not stage foreign work"))
      assert.strictEqual(snapshot._tag, "GitError")
      assert.match(snapshot.stderr, /[Oo]wnership/)
      const publish = yield* Effect.flip(service.publish(located, fixture.baseSha))
      assert.strictEqual(publish._tag, "GitError")
      assert.strictEqual(yield* git(located.path, ["diff", "--cached"]), index)
      assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
    })
  ))

it.live("ownership refuses a replacement repository at the owned workspace path", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const service = yield* Worktrees
      const worktree = yield* Effect.scoped(service.acquire(task(), fixture.baseSha))
      yield* fixture.fs.makeDirectory(worktree.path, { recursive: true })
      yield* git(worktree.path, ["init", "-b", worktree.branch])
      yield* fixture.fs.writeFileString(fixture.path.join(worktree.path, "private-work"), "foreign repository\n")
      const error = yield* Effect.flip(service.acquire(task(), fixture.baseSha))
      assert.strictEqual(error._tag, "GitError")
      assert.match(error.stderr, /[Oo]wnership/)
      assert.strictEqual(
        yield* fixture.fs.readFileString(fixture.path.join(worktree.path, "private-work")),
        "foreign repository\n",
      )
      assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
    })
  ))

for (const malformed of ["directory", "oversized", "invalid-utf8"] as const) {
  it.live(`bounded ownership refuses ${malformed} before staging, publication or removal`, () =>
    withRepo((fixture) => Effect.gen(function*() {
      const service = yield* Worktrees
      const worktree = yield* Effect.scoped(service.acquire(task(), fixture.baseSha))
      yield* Effect.scoped(Effect.gen(function*() {
        const retained = yield* service.acquire(task(), fixture.baseSha)
        yield* edit(fixture, retained)
      }))
      const receipts = fixture.path.join(fixture.repoRoot, ".git", "agentrun", "ownership", "branches")
      const entries = yield* fixture.fs.readDirectory(receipts)
      const file = fixture.path.join(receipts, entries[0]!)
      if (malformed === "directory") {
        yield* fixture.fs.rename(file, `${file}.original`)
        yield* fixture.fs.makeDirectory(file)
      } else yield* fixture.fs.writeFile(file, malformed === "oversized" ? Buffer.alloc(65537) : Buffer.from([0xc0, 0xaf]))
      const before = yield* git(fixture.repoRoot, ["show-ref"])
      const index = yield* fixture.fs.readFile(fixture.path.join(fixture.repoRoot, ".git", "worktrees", "fix-login", "index"))
      for (const operation of [service.snapshot(worktree, "refuse"), service.publish(worktree, fixture.baseSha),
        service.reconcile(state(fixture, worktree, { _tag: "succeeded", commit: fixture.baseSha }))]) {
        const result = yield* Effect.exit(operation)
        assert.strictEqual(Exit.isFailure(result), true)
      }
      assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
      assert.deepStrictEqual(yield* fixture.fs.readFile(fixture.path.join(fixture.repoRoot, ".git", "worktrees", "fix-login", "index")), index)
      assert.strictEqual(yield* fixture.fs.readFileString(fixture.path.join(worktree.path, "tracked.txt")), "tracked edit\n")
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
    })))
}
