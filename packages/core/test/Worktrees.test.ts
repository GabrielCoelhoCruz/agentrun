import { NodeServices } from "@effect/platform-node"
import { describe, it } from "@effect/vitest"
import {
  Console,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
  Stream,
} from "effect"
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
    const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-repo-" }).pipe(Effect.flatMap(fs.realPath))
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
    }), 60000)

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
        assert.strictEqual(error.command, "git rev-parse --verify missing-base-sha^{commit}")
        const direct = spawnSync("git", ["rev-parse", "--verify", "missing-base-sha^{commit}"], {
          cwd: fixture.repoRoot,
          encoding: "utf8",
        })
        assert.strictEqual(error.exitCode, direct.status)
        assert.strictEqual(error.stderr, direct.stderr)
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
    withRepo((fixture) =>
      Effect.gen(function*() {
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
        } else {yield* fixture.fs.writeFile(
            file,
            malformed === "oversized" ? Buffer.alloc(65537) : Buffer.from([0xc0, 0xaf]),
          )}
        const before = yield* git(fixture.repoRoot, ["show-ref"])
        const index = yield* fixture.fs.readFile(
          fixture.path.join(fixture.repoRoot, ".git", "worktrees", "fix-login", "index"),
        )
        for (
          const operation of [
            service.snapshot(worktree, "refuse"),
            service.publish(worktree, fixture.baseSha),
            service.reconcile(state(fixture, worktree, { _tag: "succeeded", durationMs: 1 })),
          ]
        ) {
          const result = yield* Effect.exit(operation)
          assert.strictEqual(Exit.isFailure(result), true)
        }
        assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
        assert.deepStrictEqual(
          yield* fixture.fs.readFile(fixture.path.join(fixture.repoRoot, ".git", "worktrees", "fix-login", "index")),
          index,
        )
        assert.strictEqual(
          yield* fixture.fs.readFileString(fixture.path.join(worktree.path, "tracked.txt")),
          "tracked edit\n",
        )
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
      })
    ))
}

it.live("rejects oversized generated ownership before resource creation", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const result = yield* Effect.exit(
        Effect.gen(function*() {
          const service = yield* Worktrees
          yield* service.assertAvailable(task().id)
          yield* service.acquire(task(), fixture.baseSha)
        }).pipe(Effect.provide(Worktrees.layer({ ...fixture, runId: "x".repeat(65536) })), Effect.scoped),
      )
      assert.strictEqual(Exit.isFailure(result), true)
      assert.strictEqual(yield* fixture.fs.exists(fixture.path.join(fixture.home, ".agentrun", "worktrees")), false)
      assert.strictEqual(yield* git(fixture.repoRoot, ["branch", "--list", "agentrun/*"]), "")
    })
  ))

it.live("refuses dangling receipt symlink before creating a branch or workspace", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const service = yield* Worktrees
      const worktree = service.locate(task().id)
      const receipts = fixture.path.join(fixture.repoRoot, ".git", "agentrun", "ownership", "branches")
      yield* fixture.fs.makeDirectory(receipts, { recursive: true })
      const file = fixture.path.join(
        receipts,
        `${createHash("sha256").update(worktree.branch.toLowerCase()).digest("hex")}.json`,
      )
      yield* fixture.fs.symlink(fixture.path.join(fixture.home, "missing"), file)
      const result = yield* Effect.exit(Effect.scoped(service.acquire(task(), fixture.baseSha)))
      assert.strictEqual(Exit.isFailure(result), true)
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
      assert.strictEqual(yield* git(fixture.repoRoot, ["branch", "--list", worktree.branch]), "")
    })
  ))

const receiptFile = (fixture: Fixture, worktree: Worktree) =>
  fixture.path.join(
    fixture.repoRoot,
    ".git",
    "agentrun",
    "ownership",
    "branches",
    `${createHash("sha256").update(worktree.branch.toLowerCase()).digest("hex")}.json`,
  )

const stopCreation = Effect.fn("test.stopCreation")(
  function*(fixture: Fixture, stage: "before-git" | "before-promote" | "failed-promote") {
    const original = fixture.fs
    const service = yield* Worktrees
    const worktree = service.locate(task().id)
    const file = receiptFile(fixture, worktree)
    const fs: FileSystem.FileSystem = {
      ...original,
      writeFileString: (target, content, options) => {
        if (stage === "before-git" && target === `${file}.pending`) {
          return original.writeFileString(target, content, options).pipe(Effect.andThen(Effect.interrupt))
        }
        // Also stop the old implementation at its final receipt write.
        if (stage !== "before-git" && target === file) return Effect.interrupt
        return original.writeFileString(target, content, options)
      },
      link: (source, target) => {
        if (stage === "before-git" && target === `${file}.pending`) {
          return original.link(source, target).pipe(Effect.andThen(Effect.interrupt))
        }
        return target !== file
          ? original.link(source, target)
          : stage === "failed-promote"
          ? original.link(`${source}.missing`, target)
          : Effect.interrupt
      },
    }
    const result = yield* Effect.exit(
      Effect.scoped(Effect.gen(function*() {
        return yield* (yield* Worktrees).acquire(task(), fixture.baseSha)
      })).pipe(
        Effect.provide(
          Worktrees.layer({ ...fixture, keepWorktrees: true }).pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
          ),
        ),
      ),
    )
    return { worktree, file, result }
  },
)

it.live("pending creation resumes after a stop before Git without claiming an existing branch", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const { worktree, file, result } = yield* stopCreation(fixture, "before-git")
      assert.strictEqual(Exit.hasInterrupts(result), true)
      assert.strictEqual(yield* fixture.fs.exists(file), false)
      assert.strictEqual(yield* fixture.fs.exists(`${file}.pending`), true)
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
      assert.strictEqual(yield* git(fixture.repoRoot, ["branch", "--list", worktree.branch]), "")
      const service = yield* Worktrees
      assert.deepStrictEqual(yield* service.reconcile(state(fixture, worktree, { _tag: "pending" })), [
        { _tag: "Nothing", taskId: task().id },
      ])
      yield* Effect.scoped(Effect.gen(function*() {
        const acquired = yield* service.acquire(task(), fixture.baseSha)
        assert.deepStrictEqual(acquired, worktree)
        assert.strictEqual(yield* git(acquired.path, ["rev-parse", "HEAD"]), fixture.baseSha)
        assert.strictEqual(yield* fixture.fs.exists(file), true)
        assert.strictEqual(yield* fixture.fs.exists(`${file}.pending`), false)
      }))
    })
  ))

for (const stage of ["before-promote", "failed-promote"] as const) {
  it.live(`pending creation recovers after ${stage} through reconcile and acquire`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const { worktree, file, result } = yield* stopCreation(fixture, stage)
        assert.strictEqual(Exit.isFailure(result), true)
        assert.strictEqual(yield* fixture.fs.exists(file), false)
        assert.strictEqual(yield* fixture.fs.exists(`${file}.pending`), true)
        assert.strictEqual(yield* git(worktree.path, ["rev-parse", "HEAD"]), fixture.baseSha)
        const service = yield* Worktrees
        // Pending intent cannot authorize staging, publication or cleanup.
        const snapshot = yield* Effect.flip(service.snapshot(worktree, "refuse pending"))
        assert.strictEqual(snapshot.command, "worktree ownership")
        const publish = yield* Effect.flip(service.publish(worktree, fixture.baseSha))
        assert.strictEqual(publish.command, "worktree ownership")
        assert.deepStrictEqual(
          yield* service.reconcile(state(fixture, worktree, { _tag: "interrupted", attempt: 1 })),
          [
            { _tag: "Resumable", taskId: task().id },
          ],
        )
        assert.strictEqual(yield* fixture.fs.exists(file), true)
        assert.strictEqual(yield* fixture.fs.exists(`${file}.pending`), false)
        yield* Effect.scoped(service.acquire(task(), fixture.baseSha))
      })
    ))
}

for (const change of ["commit", "untracked", "ignored", "modified", "staged"] as const) {
  it.live(`pending creation refuses ${change} and preserves the workspace`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const { worktree, file } = yield* stopCreation(fixture, "before-promote")
        const privateFile = fixture.path.join(worktree.path, change === "modified" ? "tracked.txt" : "private.txt")
        if (change === "ignored") {
          yield* fixture.fs.writeFileString(
            fixture.path.join(fixture.repoRoot, ".git", "info", "exclude"),
            "private.txt\n",
          )
        }
        yield* fixture.fs.writeFileString(privateFile, "preserve user work\n")
        if (change === "staged" || change === "commit") yield* git(worktree.path, ["add", "private.txt"])
        if (change === "commit") {
          yield* git(worktree.path, [
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@localhost",
            "commit",
            "-m",
            "User work",
          ])
        }
        const before = yield* git(fixture.repoRoot, ["show-ref"])
        const index = yield* git(worktree.path, ["diff", "--cached"])
        const service = yield* Worktrees
        for (
          const operation of [
            Effect.scoped(service.acquire(task(), fixture.baseSha)).pipe(Effect.asVoid),
            service.reconcile(state(fixture, worktree, { _tag: "pending" })).pipe(Effect.asVoid),
          ]
        ) {
          const error = yield* Effect.flip(operation)
          assert.strictEqual(error.command, "worktree ownership")
          assert.ok(
            error.stderr.includes(
              change === "commit" ? "pending branch tip differs" : "pending workspace is not clean",
            ),
          )
          assert.ok(error.stderr.includes("git -C"))
          assert.ok(error.stderr.includes("--untracked-files=all --ignored"))
          assert.ok(error.stderr.includes("worktree remove"))
          assert.ok(error.stderr.includes("branch -d"))
        }
        assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
        assert.strictEqual(yield* git(worktree.path, ["diff", "--cached"]), index)
        assert.strictEqual(yield* fixture.fs.readFileString(privateFile), "preserve user work\n")
        assert.strictEqual(yield* fixture.fs.exists(file), false)
      })
    ))
}

it.live("pending intent refuses a hand-made clean branch and worktree at the same base", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const { worktree, file } = yield* stopCreation(fixture, "before-git")
      yield* fixture.fs.makeDirectory(fixture.path.dirname(worktree.path), { recursive: true })
      yield* git(fixture.repoRoot, ["worktree", "add", "-b", worktree.branch, worktree.path, fixture.baseSha])
      const before = yield* git(fixture.repoRoot, ["show-ref"])
      const service = yield* Worktrees
      for (
        const operation of [
          Effect.scoped(service.acquire(task(), fixture.baseSha)).pipe(Effect.asVoid),
          service.reconcile(state(fixture, worktree, { _tag: "pending" })).pipe(Effect.asVoid),
        ]
      ) {
        const error = yield* Effect.flip(operation)
        assert.ok(error.stderr.includes("pending branch creation is unproved"))
      }
      assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
      assert.strictEqual(yield* fixture.fs.exists(file), false)
    })
  ))

it.live("a failed pending receipt write creates no branch or workspace", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const service = yield* Worktrees
      const worktree = service.locate(task().id)
      const file = receiptFile(fixture, worktree)
      const fs: FileSystem.FileSystem = {
        ...fixture.fs,
        writeFileString: (target, content, options) =>
          target === `${file}.pending` || content.includes("\"baseSha\":")
            ? fixture.fs.writeFileString(fixture.path.join(fixture.home, "missing", "receipt"), content, options)
            : fixture.fs.writeFileString(target, content, options),
      }
      const result = yield* Effect.exit(
        Effect.scoped(Effect.gen(function*() {
          return yield* (yield* Worktrees).acquire(task(), fixture.baseSha)
        })).pipe(
          Effect.provide(Worktrees.layer(fixture).pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)))),
        ),
      )
      assert.strictEqual(Exit.isFailure(result), true)
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
      assert.strictEqual(yield* git(fixture.repoRoot, ["branch", "--list", worktree.branch]), "")
      assert.strictEqual(yield* fixture.fs.exists(file), false)
    })
  ))

for (const malformed of ["oversized", "symlink", "different-base", "invalid-json"] as const) {
  it.live(`pending creation refuses ${malformed} without mutation`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const { worktree, file } = yield* stopCreation(fixture, "before-promote")
        const pending = `${file}.pending`
        if (malformed === "oversized") yield* fixture.fs.writeFileString(pending, "x".repeat(65537))
        else if (malformed === "symlink") {
          yield* fixture.fs.rename(pending, `${pending}.saved`)
          yield* fixture.fs.symlink(`${pending}.saved`, pending)
        } else if (malformed === "different-base") {
          const content = yield* fixture.fs.readFileString(pending)
          yield* fixture.fs.writeFileString(pending, content.replace(fixture.baseSha, "0".repeat(40)))
        } else yield* fixture.fs.writeFileString(pending, "{")
        const before = yield* git(fixture.repoRoot, ["show-ref"])
        const result = yield* Effect.exit((yield* Worktrees).reconcile(state(fixture, worktree, { _tag: "pending" })))
        assert.strictEqual(Exit.isFailure(result), true)
        assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
        assert.strictEqual(yield* fixture.fs.exists(file), false)
      })
    ))
}

it.live("pending creation recreates a missing directory only with the branch creation witness", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const { worktree, file } = yield* stopCreation(fixture, "before-promote")
      yield* git(fixture.repoRoot, ["worktree", "remove", worktree.path])
      const service = yield* Worktrees
      assert.deepStrictEqual(yield* service.reconcile(state(fixture, worktree, { _tag: "interrupted", attempt: 1 })), [
        { _tag: "Resumable", taskId: task().id },
      ])
      assert.strictEqual(yield* git(worktree.path, ["rev-parse", "HEAD"]), fixture.baseSha)
      assert.strictEqual(yield* fixture.fs.exists(file), true)
    })
  ))

it.live("pending creation rejects extra branch history even when the tip returns to the base", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const { worktree, file } = yield* stopCreation(fixture, "before-promote")
      yield* git(worktree.path, [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "--allow-empty",
        "-m",
        "User commit",
      ])
      yield* git(fixture.repoRoot, ["update-ref", `refs/heads/${worktree.branch}`, fixture.baseSha])
      const before = yield* git(fixture.repoRoot, ["show-ref"])
      const error = yield* Effect.flip((yield* Worktrees).reconcile(state(fixture, worktree, { _tag: "pending" })))
      assert.ok(error.stderr.includes("pending branch creation is unproved"))
      assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
      assert.strictEqual(yield* fixture.fs.exists(file), false)
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
    })
  ))

it.live("pending receipt reserves the name before Git starts", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const { worktree } = yield* stopCreation(fixture, "before-git")
      const error = yield* Effect.flip((yield* Worktrees).assertAvailable(task().id))
      assert.strictEqual(error.stderr, `Worktree collision: ${worktree.branch}; choose a different run ID`)
    })
  ))

const checkoutHook = Effect.fn("test.checkoutHook")(
  function*(fixture: Fixture, mode: "ignored" | "untracked" | "modified") {
    const name = mode === "modified" ? "tracked.txt" : ".hook-output"
    if (mode === "ignored") {
      yield* fixture.fs.writeFileString(
        fixture.path.join(fixture.repoRoot, ".git", "info", "exclude"),
        ".hook-output\n",
      )
    }
    const hook = fixture.path.join(fixture.repoRoot, ".git", "hooks", "post-checkout")
    yield* fixture.fs.writeFileString(hook, `#!/bin/sh\nprintf 'hook output\\n' > ${name}\n`)
    yield* fixture.fs.chmod(hook, 0o755)
    return name
  },
)

for (const mode of ["ignored", "untracked", "modified"] as const) {
  it.live(`review fresh acquisition preserves ${mode} checkout hook output`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const name = yield* checkoutHook(fixture, mode)
        const worktree = yield* Effect.scoped(Effect.gen(function*() {
          return yield* (yield* Worktrees).acquire(task(), fixture.baseSha)
        })).pipe(Effect.provide(Worktrees.layer({ ...fixture, keepWorktrees: true })))
        assert.strictEqual(yield* fixture.fs.readFileString(fixture.path.join(worktree.path, name)), "hook output\n")
        assert.strictEqual(yield* fixture.fs.exists(receiptFile(fixture, worktree)), true)
        assert.strictEqual(yield* fixture.fs.exists(`${receiptFile(fixture, worktree)}.pending`), false)
        assert.strictEqual(yield* git(worktree.path, ["rev-parse", "HEAD"]), fixture.baseSha)
      })
    ))
}

it.live("fresh acquisition refuses a checkout hook that selects a foreign branch", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      yield* git(fixture.repoRoot, ["branch", "user-branch", fixture.baseSha])
      const hook = fixture.path.join(fixture.repoRoot, ".git", "hooks", "post-checkout")
      yield* fixture.fs.writeFileString(
        hook,
        "#!/bin/sh\nrm -- \"$0\"\ngit checkout user-branch\nprintf 'preserve user file\\n' > private.txt\n",
      )
      yield* fixture.fs.chmod(hook, 0o755)
      const service = yield* Worktrees
      const worktree = service.locate(task().id)
      const error = yield* Effect.flip(Effect.scoped(service.acquire(task(), fixture.baseSha)))
      assert.strictEqual(error.command, "worktree ownership")
      assert.ok(error.stderr.includes("workspace Git identity differs"))
      assert.strictEqual(yield* fixture.fs.exists(receiptFile(fixture, worktree)), false)
      assert.strictEqual(yield* git(worktree.path, ["symbolic-ref", "HEAD"]), "refs/heads/user-branch")
      assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", "user-branch"]), fixture.baseSha)
      assert.strictEqual(
        yield* fixture.fs.readFileString(fixture.path.join(worktree.path, "private.txt")),
        "preserve user file\n",
      )
    })
  ))

it.live("review crash recovery preserves hook output whose source cannot be proved", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      yield* checkoutHook(fixture, "ignored")
      const { worktree, file } = yield* stopCreation(fixture, "before-promote")
      const before = yield* git(fixture.repoRoot, ["show-ref"])
      for (
        const operation of [
          Effect.scoped((yield* Worktrees).acquire(task(), fixture.baseSha)).pipe(Effect.asVoid),
          (yield* Worktrees).reconcile(state(fixture, worktree, { _tag: "pending" })).pipe(Effect.asVoid),
        ]
      ) {
        const error = yield* Effect.flip(operation)
        assert.ok(error.stderr.includes("pending workspace is not clean"))
        assert.ok(error.stderr.includes("Crash recovery cannot prove which files the hook wrote"))
        assert.ok(error.stderr.includes("clean --dry-run -d -x"))
        assert.ok(error.stderr.includes("Move only confirmed disposable files to your backup"))
      }
      assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
      assert.strictEqual(
        yield* fixture.fs.readFileString(fixture.path.join(worktree.path, ".hook-output")),
        "hook output\n",
      )
      assert.strictEqual(yield* fixture.fs.exists(file), false)
    })
  ))

for (const operation of ["acquire", "reconcile"] as const) {
  it.live(`review ${operation} recreates a raw-deleted pending workspace without pruning other registrations`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const { worktree, file } = yield* stopCreation(fixture, "before-promote")
        const other = fixture.path.join(fixture.repoRoot, "other-live")
        const missing = fixture.path.join(fixture.repoRoot, "other-missing")
        yield* git(fixture.repoRoot, ["worktree", "add", "--detach", other, fixture.baseSha])
        yield* git(fixture.repoRoot, ["worktree", "add", "--detach", missing, fixture.baseSha])
        yield* fixture.fs.writeFileString(fixture.path.join(other, "private"), "preserve other work\n")
        yield* fixture.fs.remove(missing, { recursive: true })
        yield* fixture.fs.remove(worktree.path, { recursive: true })
        const service = yield* Worktrees
        if (operation === "acquire") {
          yield* Effect.scoped(Effect.gen(function*() {
            return yield* (yield* Worktrees).acquire(task(), fixture.baseSha)
          })).pipe(
            Effect.provide(Worktrees.layer({ ...fixture, keepWorktrees: true })),
          )
        } else {assert.deepStrictEqual(
            yield* service.reconcile(state(fixture, worktree, { _tag: "interrupted", attempt: 1 })),
            [
              { _tag: "Resumable", taskId: task().id },
            ],
          )}
        assert.strictEqual(yield* git(worktree.path, ["rev-parse", "HEAD"]), fixture.baseSha)
        assert.strictEqual(yield* fixture.fs.exists(file), true)
        const registered = yield* git(fixture.repoRoot, ["worktree", "list", "--porcelain"])
        assert.ok(registered.includes(`worktree ${missing}\n`))
        assert.ok(registered.includes(`worktree ${other}\n`))
        assert.strictEqual(
          yield* fixture.fs.readFileString(fixture.path.join(other, "private")),
          "preserve other work\n",
        )
      })
    ))
}

it.live("review missing locked pending workspace stays locked and unmodified", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const { worktree, file } = yield* stopCreation(fixture, "before-promote")
      yield* git(fixture.repoRoot, ["worktree", "lock", "--reason", "user lock", worktree.path])
      yield* fixture.fs.remove(worktree.path, { recursive: true })
      const before = yield* git(fixture.repoRoot, ["worktree", "list", "--porcelain"])
      const refs = yield* git(fixture.repoRoot, ["show-ref"])
      const result = yield* Effect.exit(
        (yield* Worktrees).reconcile(state(fixture, worktree, { _tag: "interrupted", attempt: 1 })),
      )
      assert.strictEqual(Exit.isFailure(result), true)
      assert.strictEqual(yield* git(fixture.repoRoot, ["worktree", "list", "--porcelain"]), before)
      assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), refs)
      assert.strictEqual(yield* fixture.fs.exists(file), false)
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
    })
  ))

for (const prefix of ["", "{\"version\":1,"]) {
  it.live(`review interrupted pending write publishes no partial receipt (${prefix === "" ? "empty" : "prefix"})`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = service.locate(task().id)
        const pending = `${receiptFile(fixture, worktree)}.pending`
        const fs: FileSystem.FileSystem = {
          ...fixture.fs,
          writeFileString: (target, content, options) =>
            content.includes("\"baseSha\":")
              ? fixture.fs.writeFileString(target, prefix, options).pipe(Effect.andThen(Effect.interrupt))
              : fixture.fs.writeFileString(target, content, options),
        }
        const result = yield* Effect.exit(
          Effect.scoped(Effect.gen(function*() {
            return yield* (yield* Worktrees).acquire(task(), fixture.baseSha)
          })).pipe(
            Effect.provide(Worktrees.layer(fixture).pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)))),
          ),
        )
        assert.strictEqual(Exit.hasInterrupts(result), true)
        assert.strictEqual(yield* fixture.fs.exists(pending), false)
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
        assert.strictEqual(yield* git(fixture.repoRoot, ["branch", "--list", worktree.branch]), "")
        yield* Effect.scoped(service.acquire(task(), fixture.baseSha))
      })
    ))
}

it.live("review atomic pending publication preserves a competing record", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const service = yield* Worktrees
      const worktree = service.locate(task().id)
      const pending = `${receiptFile(fixture, worktree)}.pending`
      const fs: FileSystem.FileSystem = {
        ...fixture.fs,
        link: (source, target) =>
          target === pending
            ? fixture.fs.writeFileString(pending, "other writer\n", { flag: "wx" }).pipe(
              Effect.andThen(fixture.fs.link(source, target)),
            )
            : fixture.fs.link(source, target),
      }
      const result = yield* Effect.exit(
        Effect.scoped(Effect.gen(function*() {
          return yield* (yield* Worktrees).acquire(task(), fixture.baseSha)
        })).pipe(
          Effect.provide(Worktrees.layer(fixture).pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)))),
        ),
      )
      assert.strictEqual(Exit.isFailure(result), true)
      assert.strictEqual(yield* fixture.fs.readFileString(pending), "other writer\n")
      assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
      assert.strictEqual(yield* git(fixture.repoRoot, ["branch", "--list", worktree.branch]), "")
    })
  ))

for (const pending of [false, true]) {
  it.live(`review disabled reflogs refuse a hand-made branch (${pending ? "pending intent" : "no receipt"})`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const service = yield* Worktrees
        const worktree = pending ? (yield* stopCreation(fixture, "before-git")).worktree : service.locate(task().id)
        yield* git(fixture.repoRoot, ["config", "core.logAllRefUpdates", "false"])
        yield* git(fixture.repoRoot, ["branch", worktree.branch, fixture.baseSha])
        assert.strictEqual(yield* git(fixture.repoRoot, ["reflog", "show", "--format=%H %gs", worktree.branch]), "")
        const before = yield* git(fixture.repoRoot, ["show-ref"])
        for (
          const action of [
            Effect.scoped(service.acquire(task(), fixture.baseSha)).pipe(Effect.asVoid),
            service.reconcile(state(fixture, worktree, { _tag: "pending" })).pipe(Effect.asVoid),
            service.publish(worktree, fixture.baseSha),
          ]
        ) {
          const error = yield* Effect.flip(action)
          assert.strictEqual(error.command, "worktree ownership")
        }
        assert.strictEqual(yield* git(fixture.repoRoot, ["show-ref"]), before)
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
      })
    ))
}
