import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Path, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import assert from "node:assert/strict"
import { repoHash } from "../src/RepoHash.js"
import { RunLock } from "../src/RunLock.js"
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
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-runner-repo-" })
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-runner-home-" })
    yield* git(repoRoot, ["init", "-b", "main"])
    yield* git(repoRoot, ["config", "commit.gpgsign", "false"])
    yield* fs.writeFileString(path.join(repoRoot, "tracked.txt"), "original\n")
    yield* git(repoRoot, ["add", "tracked.txt"])
    yield* git(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "Initial"])
    const baseSha = yield* git(repoRoot, ["rev-parse", "main"])
    const runId = "20261003T1200-a1b2"
    yield* test({ fs, path, repoRoot, home, baseSha, runId }).pipe(
      Effect.provide(RunLock.layer({ home })),
    )
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
)

it.live("rejects concurrent scopes and releases the lock", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const lock = yield* RunLock
      const scope = yield* Scope.make()
      yield* lock.acquire(fixture.repoRoot).pipe(Effect.provideService(Scope.Scope, scope))
      const error = yield* Effect.flip(Effect.scoped(lock.acquire(fixture.repoRoot)))
      assert.ok(error._tag === "RunLocked")
      assert.strictEqual(error.pid, process.pid)
      yield* Scope.close(scope, Exit.succeed(undefined))
      yield* Effect.scoped(lock.acquire(fixture.repoRoot))
      assert.strictEqual(yield* fixture.fs.exists(error.path), false)
    })
  ))
it.live("replaces a confirmed stale pid", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const pid = 2 ** 22 - 1
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
      const hash = yield* repoHash(fixture.repoRoot)
      const file = fixture.path.join(fixture.home, ".agentrun", "locks", `${hash}.lock`)
      yield* fixture.fs.makeDirectory(fixture.path.dirname(file), { recursive: true })
      yield* fixture.fs.writeFileString(file, String(pid))
      yield* Effect.scoped(Effect.gen(function*() {
        yield* (yield* RunLock).acquire(fixture.repoRoot)
        assert.strictEqual(yield* fixture.fs.readFileString(file), String(process.pid))
      }))
      assert.strictEqual(yield* fixture.fs.exists(file), false)
    })
  ))
it.live("locks different repositories independently", () =>
  withRepo((fixture) =>
    Effect.scoped(Effect.gen(function*() {
      const second = yield* fixture.fs.makeTempDirectoryScoped()
      yield* git(second, ["init"])
      const lock = yield* RunLock
      yield* lock.acquire(fixture.repoRoot)
      yield* lock.acquire(second)
    }))
  ))
for (const pid of ["", "garbage", "0", "-1", "1.5"]) {
  it.live(`rejects an invalid pid ${pid}`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const hash = yield* repoHash(fixture.repoRoot)
        const file = fixture.path.join(fixture.home, ".agentrun", "locks", `${hash}.lock`)
        yield* fixture.fs.makeDirectory(fixture.path.dirname(file), { recursive: true })
        yield* fixture.fs.writeFileString(file, pid)
        const error = yield* Effect.flip(Effect.scoped((yield* RunLock).acquire(fixture.repoRoot)))
        assert.strictEqual(error._tag, "RunLocked")
        assert.strictEqual(yield* fixture.fs.readFileString(file), pid)
      })
    ))
}

it.live("shares the lock across git worktrees", () =>
  withRepo((fixture) =>
    Effect.scoped(Effect.gen(function*() {
      const other = fixture.path.join(fixture.home, "linked")
      yield* git(fixture.repoRoot, ["worktree", "add", "-b", "linked", other])
      const lock = yield* RunLock
      yield* lock.acquire(fixture.repoRoot)
      const error = yield* Effect.flip(Effect.scoped(lock.acquire(other)))
      assert.ok(error._tag === "RunLocked")
      assert.strictEqual(error.pid, process.pid)
    }))
  ))

it.live("keeps a stale lock when a crashed reclaim guard exists", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const hash = yield* repoHash(fixture.repoRoot)
      const file = fixture.path.join(fixture.home, ".agentrun", "locks", `${hash}.lock`)
      yield* fixture.fs.makeDirectory(fixture.path.dirname(file), { recursive: true })
      const pid = String(2 ** 22 - 1)
      yield* fixture.fs.writeFileString(file, pid)
      yield* fixture.fs.writeFileString(`${file}.reclaim`, "")
      const error = yield* Effect.flip(Effect.scoped((yield* RunLock).acquire(fixture.repoRoot)))
      assert.strictEqual(error._tag, "RunLocked")
      assert.strictEqual(yield* fixture.fs.readFileString(file), pid)
      assert.strictEqual(yield* fixture.fs.exists(`${file}.reclaim`), true)
    })
  ))
