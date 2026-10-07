import { Effect, Predicate, Schema } from "effect"
import { systemError } from "effect/PlatformError"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isAlive } from "./RunLock.js"

const exec = promisify(execFile)

// A zombie has exited but can retain its PID and group until its parent reaps it.
const processTable = Effect.fn("ProcessGroup.table")(function*(includeCommand = false) {
  const error = (cause: unknown) => systemError({ _tag: "Unknown", module: "ProcessGroup", method: "table", cause })
  const table = yield* Effect.tryPromise({
    try: () =>
      exec(
        "ps",
        includeCommand
          ? ["-axo", "pid=,ppid=,pgid=,stat=,command=", "-ww"]
          : ["-axo", "pid=,ppid=,pgid=,stat="],
        { timeout: 5000 },
      ),
    catch: () => error("Could not read process table"),
  })
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    parent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    group: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    state: Schema.NonEmptyString,
    command: Schema.String,
  })))(
    table.stdout.replace(/\r?\n$/, "").split("\n").map((line) => {
      const fields = /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+([^ \t\r\n]+)(?:[ \t]+(.*))?$/.exec(line)
      if (fields === null) return undefined
      const [, pid, parent, group, state, command = ""] = fields
      return { pid: Number(pid), parent: Number(parent), group: Number(group), state, command }
    }),
  ).pipe(Effect.mapError(() => error("Invalid process table")))
  if (new Set(rows.map((row) => row.pid)).size !== rows.length) {
    return yield* error("Duplicate process ID in process table")
  }
  return rows
})
const running = (state: string) => !state.startsWith("Z")

export const stopProcessGroup = Effect.fn("stopProcessGroup")(
  function*(pgid: number, token?: string, kind: "worker" | "git" | "factory" = "worker") {
    const error = (cause: unknown) => systemError({ _tag: "Unknown", module: "ProcessGroup", method: "stop", cause })
    if (!Number.isSafeInteger(pgid) || pgid <= 1) return yield* error("Invalid process group")
    if (!(yield* isAlive(-pgid))) return
    if (token === undefined || !/^[a-f0-9]{32}$/.test(token)) {
      return yield* error("Live process group has no verified ownership token; recovery refused")
    }
    const rows = yield* processTable(true)
    const members = rows.filter((row) => row.group === pgid)
    if (members.length === 0) {
      if (!(yield* isAlive(-pgid))) return
      return yield* error("Live process group absent from process table; recovery refused")
    }
    if (members.every((row) => !running(row.state))) return
    const leader = rows.find((row) => row.pid === pgid && row.group === pgid)
    if (leader === undefined || !leader.command.trim().split(/\s+/).includes(`agentrun-${kind}-${token}`)) {
      return yield* error("Process group ownership changed; recovery refused")
    }
    const owned = new Set([pgid])
    let previousSize = 0
    while (previousSize !== owned.size) {
      previousSize = owned.size
      for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
    }
    const groups = new Set([pgid])
    for (const row of rows) {
      if (!owned.has(row.pid)) continue
      if (row.group <= 1 || !owned.has(row.group)) {
        return yield* error("Descendant joined an unowned group; cleanup refused")
      }
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
        const current = yield* processTable()
        for (const group of groups) {
          const members = current.filter((row) => row.group === group)
          if (members.every((row) => !running(row.state)) && (members.length > 0 || !(yield* isAlive(-group)))) {
            groups.delete(group)
          }
        }
        if (groups.size === 0) return
        yield* Effect.sleep("50 millis")
      }
    }
    return yield* error("Owned process group did not exit after SIGKILL; recovery refused")
  },
)
