import { Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema, Stream } from "effect"
import type { Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { GitError, RunLocked } from "./domain/Errors.js"
import { repoHash } from "./RepoHash.js"

export const isAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return !(Predicate.isObject(error) && "code" in error && error.code === "ESRCH")
    }
  })

export const lockUtility = (platform: string = process.platform) =>
  platform === "darwin" ? "/usr/bin/lockf" : platform === "linux" ? "flock" : undefined

const marker = "agentrun-reclaim-v1\n"
// EOF also closes the lease after parent SIGKILL. No descendant keeps stdin open.
const leaseProgram =
  "process.stdout.write(\"ready\\n\");process.stdin.resume();process.stdin.on(\"end\",()=>process.exit(0))"

export class RunLock extends Context.Service<RunLock, {
  readonly acquire: (repoRoot: string) => Effect.Effect<void, RunLocked | GitError | PlatformError, Scope.Scope>
}>()("agentrun/RunLock") {
  static readonly layer = (options: { readonly home: string }) =>
    Layer.effect(
      RunLock,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = path.join(options.home, ".agentrun", "locks")
        const acquire = Effect.fn("RunLock.acquire")(function*(repoRoot: string) {
          const hash = yield* repoHash(repoRoot).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
          const target = path.join(directory, `${hash}.lock`)
          const guard = `${target}.reclaim`
          const utility = lockUtility()
          if (utility === undefined) {
            return yield* new GitError({
              command: "repository lock",
              exitCode: -1,
              stderr: "Unsupported OS; requires macOS lockf or Linux flock",
            })
          }
          yield* fs.makeDirectory(directory, { recursive: true })
          const publish = Effect.fn("RunLock.publish")(function*(destination: string, content: string) {
            const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".publish-" })
            const file = path.join(temporary, "contents")
            yield* fs.writeFileString(file, content)
            yield* fs.link(file, destination)
          }, Effect.scoped)
          // Permanent protocol marker: legacy wx claimants refuse, and every new caller locks this inode.
          yield* publish(guard, marker).pipe(Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            () => Effect.void,
          ))
          if ((yield* fs.readFileString(guard)) !== marker) return yield* new RunLocked({ path: target, pid: 0 })
          const args = process.platform === "darwin"
            ? ["-k", "-n", "-t", "0", guard, process.execPath, "-e", leaseProgram]
            : ["-n", "-E", "75", guard, process.execPath, "-e", leaseProgram]
          const helper = yield* spawner.spawn(ChildProcess.make(utility, args)).pipe(Effect.mapError((error) =>
            new GitError({ command: utility, exitCode: -1, stderr: `Lock utility unavailable: ${error.message}` })
          ))
          const ready = yield* helper.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
          if (!Option.contains(ready, "ready")) {
            const [code, stderr] = yield* Effect.all([
              helper.exitCode,
              helper.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ], { concurrency: "unbounded" })
            if (code === 75) {
              const pid = yield* fs.readFileString(target).pipe(
                Effect.map(Number),
                Effect.catch(() =>
                  Effect.succeed(0)
                ),
              )
              return yield* new RunLocked({ path: target, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0 })
            }
            return yield* new GitError({ command: utility, exitCode: code, stderr })
          }
          yield* Effect.addFinalizer(() =>
            Stream.run(Stream.empty, helper.stdin).pipe(Effect.andThen(helper.exitCode), Effect.orDie)
          )
          const create = publish(target, String(process.pid))
          yield* Effect.acquireRelease(
            create.pipe(Effect.catchIf(
              (error) => error.reason._tag === "AlreadyExists",
              () =>
                Effect.gen(function*() {
                  const content = yield* fs.readFileString(target)
                  const decoded = Schema.decodeOption(Schema.Int.check(Schema.isGreaterThan(0)))(Number(content))
                  if (content.trim() === "" || decoded._tag === "None") {
                    return yield* new RunLocked({ path: target, pid: 0 })
                  }
                  const pid = decoded.value
                  if (yield* isAlive(pid)) {
                    return yield* new RunLocked({ path: target, pid })
                  }
                  yield* fs.remove(target)
                  yield* create.pipe(Effect.catchIf(
                    (error) => error.reason._tag === "AlreadyExists",
                    () => Effect.fail(new RunLocked({ path: target, pid })),
                  ))
                }),
            )),
            () => fs.remove(target).pipe(Effect.orDie),
          )
        })
        return RunLock.of({ acquire })
      }),
    )
}
