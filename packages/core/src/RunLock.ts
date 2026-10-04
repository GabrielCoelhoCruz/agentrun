import { Context, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect"
import type { Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcessSpawner } from "effect/process"
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
          yield* fs.makeDirectory(directory, { recursive: true })
          const create = Effect.scoped(Effect.gen(function*() {
            const file = yield* fs.open(target, { flag: "wx" })
            yield* file.writeAll(new TextEncoder().encode(String(process.pid))).pipe(
              Effect.onError(() => fs.remove(target).pipe(Effect.orDie)),
            )
          }))
          yield* Effect.acquireRelease(
            create.pipe(Effect.catch((error) =>
              Effect.gen(function*() {
                if (error.reason._tag !== "AlreadyExists") return yield* error
                return yield* Effect.scoped(Effect.gen(function*() {
                  const guard = `${target}.reclaim`
                  yield* Effect.acquireRelease(
                    fs.open(guard, { flag: "wx" }).pipe(Effect.catchIf(
                      (guardError) => guardError.reason._tag === "AlreadyExists",
                      () => Effect.fail(new RunLocked({ path: target, pid: 0 })),
                    )),
                    () => fs.remove(guard).pipe(Effect.orDie),
                  )
                  const content = yield* fs.readFileString(target).pipe(Effect.result)
                  if (content._tag === "Failure") {
                    if (content.failure.reason._tag === "NotFound") return yield* create
                    return yield* content.failure
                  }
                  const decoded = Schema.decodeOption(Schema.Int.check(Schema.isGreaterThan(0)))(
                    Number(content.success),
                  )
                  if (content.success.trim() === "" || decoded._tag === "None") {
                    return yield* new RunLocked({ path: target, pid: 0 })
                  }
                  const pid = decoded.value
                  if (yield* isAlive(pid)) {
                    return yield* new RunLocked({ path: target, pid })
                  }
                  yield* fs.remove(target)
                  return yield* create.pipe(Effect.catchIf(
                    (retryError) => retryError.reason._tag === "AlreadyExists",
                    () => Effect.fail(new RunLocked({ path: target, pid })),
                  ))
                }))
              })
            )),
            () => fs.remove(target).pipe(Effect.orDie),
          )
        })
        return RunLock.of({ acquire })
      }),
    )
}
