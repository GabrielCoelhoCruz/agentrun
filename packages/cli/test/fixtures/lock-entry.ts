import { RunLock } from "@agentrun/core"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { writeFileSync } from "node:fs"
const home = process.env.HOME
const records = process.env.TEST_RECORDS
if (home === undefined || records === undefined) throw new Error("Missing test paths")
Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const observed = {
    ...fs,
    remove: (path: string, options?: Parameters<FileSystem.FileSystem["remove"]>[1]) => {
      if (path.endsWith(".lock") && process.env.TEST_STOP_REPLACEMENT === "yes") {
        writeFileSync(`${records}/replacement-stop`, String(process.pid))
        process.kill(process.pid, "SIGSTOP")
      }
      return fs.remove(path, options)
    },
  }
  return yield* Effect.gen(function*() {
    yield* (yield* RunLock).acquire(process.cwd())
    writeFileSync(`${records}/lease-acquired`, String(process.pid))
    return yield* Effect.never
  }).pipe(Effect.provide(RunLock.layer({ home })), Effect.provideService(FileSystem.FileSystem, observed))
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain)
