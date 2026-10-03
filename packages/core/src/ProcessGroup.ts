import { Effect, Predicate, Schema } from "effect"
import { systemError } from "effect/PlatformError"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isAlive } from "./RunLock.js"

const exec = promisify(execFile)

// Only groups with a recorded, unguessable worker argument can be recovered.
export const stopProcessGroup = Effect.fn("stopProcessGroup")(function*(pgid: number, token?: string) {
  const error = (cause: unknown) => systemError({ _tag: "Unknown", module: "ProcessGroup", method: "stop", cause })
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return yield* error("Invalid process group")
  if (!(yield* isAlive(-pgid))) return
  if (token === undefined || !/^[a-f0-9]{32}$/.test(token)) {
    return yield* error("Live process group has no verified ownership token; recovery refused")
  }
  const command = yield* Effect.tryPromise({
    try: () => exec("ps", ["-p", String(pgid), "-o", "command="], { timeout: 5000 }),
    catch: error,
  })
  if (!command.stdout.trim().split(/\s+/).includes(`agentrun-worker-${token}`)) {
    return yield* error("Process group ownership changed; recovery refused")
  }
  const table = yield* Effect.tryPromise({
    try: () => exec("ps", ["-axo", "pid=,ppid=,pgid="], { timeout: 5000 }),
    catch: error,
  })
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    parent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    group: Schema.Int.check(Schema.isGreaterThan(0)),
  })))(
    table.stdout.trim().split("\n").map((line) => {
      const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
      return { pid, parent, group }
    }),
  ).pipe(Effect.mapError(error))
  const owned = new Set([pgid])
  let previousSize = 0
  while (previousSize !== owned.size) {
    previousSize = owned.size
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
  }
  const groups = new Set([pgid])
  for (const row of rows) {
    if (!owned.has(row.pid)) continue
    if (!owned.has(row.group)) return yield* error("Descendant joined an unowned group; cleanup refused")
    groups.add(row.group)
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const group of groups) {
      yield* Effect.try({ try: () => process.kill(-group, signal), catch: error }).pipe(
        Effect.catchIf(
          (e) => Predicate.isObject(e.reason.cause) && "code" in e.reason.cause && e.reason.cause.code === "ESRCH",
          () => Effect.void,
        ),
      )
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const group of groups) if (!(yield* isAlive(-group))) groups.delete(group)
      if (groups.size === 0) return
      yield* Effect.sleep("50 millis")
    }
  }
  return yield* error("Owned process group did not exit after SIGKILL; recovery refused")
})
