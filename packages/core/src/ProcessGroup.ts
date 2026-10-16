import { Effect, Predicate, Schema } from "effect"
import { systemError } from "effect/PlatformError"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isAlive } from "./RunLock.js"
import { subprocessFailure } from "./SubprocessFailure.js"

const exec = promisify(execFile)

const processTable = Effect.fn("ProcessGroup.table")(function*(includeCommand = false) {
  const error = (cause: unknown) => systemError({ _tag: "Unknown", module: "ProcessGroup", method: "table", cause })
  const table = yield* Effect.tryPromise({
    try: () =>
      exec(
        "ps",
        includeCommand
          ? ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command=", "-ww"]
          : ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
        { timeout: 5000, env: { ...process.env, LC_ALL: "C" } },
      ),
    catch: (cause) => error(`Could not read process table: ${subprocessFailure(cause, 5000)}`),
  })
  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    parent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    group: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    state: Schema.NonEmptyString,
    started: Schema.NonEmptyString,
    command: Schema.String,
  })))(
    table.stdout.replace(/\r?\n$/, "").split("\n").map((line) => {
      const fields =
        /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+([^ \t\r\n]+)[ \t]+(\w{3} +\w{3} +\d+ +\d{2}:\d{2}:\d{2} +\d{4})(?:[ \t]+(.*))?$/
          .exec(line)
      if (fields === null) return undefined
      const [, pid, parent, group, state, started, command = ""] = fields
      return { pid: Number(pid), parent: Number(parent), group: Number(group), state, started, command }
    }),
  ).pipe(Effect.mapError(() => error("Invalid process table")))
  if (new Set(rows.map((row) => row.pid)).size !== rows.length) {
    return yield* error("Duplicate process ID in process table")
  }
  return rows
})
// A zombie has exited but can retain its PID and group until its parent reaps it.
const running = (state: string) => !state.includes("Z") && !(process.platform === "darwin" && state.includes("E"))

export const stopProcessGroup = Effect.fn("stopProcessGroup")(
  function*(pgid: number, token?: string, kind: "worker" | "git" | "factory" = "worker") {
    const error = (cause: unknown) => systemError({ _tag: "Unknown", module: "ProcessGroup", method: "stop", cause })
    if (!Number.isSafeInteger(pgid) || pgid <= 1) return yield* error("Invalid process group")
    // If the group has already exited, no snapshot is taken. A detached daemon can survive (#58).
    if (!(yield* isAlive(-pgid))) return
    if (token === undefined || !/^[a-f0-9]{32}$/.test(token)) {
      return yield* error("Live process group has no verified ownership token; recovery refused")
    }
    const rows = yield* processTable(true)
    const members = rows.filter((row) => row.group === pgid)
    const leader = rows.find((row) => row.pid === pgid && row.group === pgid)
    const unverified = members.length === 0
      ? "Live process group absent from process table; recovery refused"
      : leader === undefined || !leader.command.trim().split(/\s+/).includes(`agentrun-${kind}-${token}`)
      ? "Process group ownership changed; recovery refused"
      : undefined
    // Both paths observe the same family; only verified ownership permits signals.
    const maySignal = unverified === undefined
    const owned = new Set([pgid, ...members.map((row) => row.pid)])
    let previousSize = 0
    while (previousSize !== owned.size) {
      previousSize = owned.size
      for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
    }
    const identities = new Map(rows.filter((row) => owned.has(row.pid)).map((row) => [row.pid, row.started]))
    const groups = new Set([pgid])
    for (const row of rows) {
      if (!owned.has(row.pid)) continue
      if (row.group <= 1 || !owned.has(row.group)) {
        return yield* error(unverified ?? "Descendant joined an unowned group; cleanup refused")
      }
      groups.add(row.group)
    }
    const waitOnly = new Set<number>()
    const observe = (current: typeof rows) => {
      const alive = new Set(
        current.filter((row) => identities.get(row.pid) === row.started && running(row.state))
          .map((row) => row.pid),
      )
      let previousSize = -1
      // A process can fork a detached child on SIGTERM, then exit before the first poll or between later snapshots.
      // The child can first appear with parent PID 1; polling cannot recover its ancestry. See #58.
      while (previousSize !== alive.size) {
        previousSize = alive.size
        for (const row of current) {
          if (running(row.state) && alive.has(row.parent) && !alive.has(row.pid)) {
            alive.add(row.pid)
            identities.set(row.pid, row.started)
          }
        }
      }
      for (const row of current) if (alive.has(row.pid) && row.group > 1) groups.add(row.group)
      return alive
    }
    let firstSignal = true
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const group of groups) {
        if (!maySignal || waitOnly.has(group)) continue
        const current = firstSignal ? rows : yield* processTable(true)
        // Retain descendants before a signal can remove their parent from the next snapshot.
        observe(current)
        firstSignal = false
        const members = current.filter((row) => row.group === group)
        if (members.every((row) => !running(row.state)) && (members.length > 0 || !(yield* isAlive(-group)))) {
          groups.delete(group)
          continue
        }
        const original = rows.find((row) => row.pid === group && row.group === group && owned.has(row.pid))
        const leader = current.find((row) => row.pid === group && row.group === group)
        // A late group has no initial ownership proof; tracking alone does not permit a signal.
        if (
          original === undefined || leader === undefined || leader.started !== original.started
          || leader.command !== original.command
        ) {
          waitOnly.add(group)
          continue
        }
        yield* Effect.try({ try: () => process.kill(-group, signal), catch: error }).pipe(
          Effect.catchIf(
            (e) =>
              Predicate.isObject(e.reason.cause) && "code" in e.reason.cause
              && (e.reason.cause.code === "ESRCH" || e.reason.cause.code === "EPERM"),
            (e) =>
              Effect.sync(() => {
                if (Predicate.isObject(e.reason.cause) && "code" in e.reason.cause && e.reason.cause.code === "EPERM") {
                  waitOnly.add(group)
                }
              }),
          ),
        )
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        const current = yield* processTable()
        const alive = observe(current)
        for (const group of groups) {
          const members = current.filter((row) => row.group === group)
          if (members.every((row) => !running(row.state)) && (members.length > 0 || !(yield* isAlive(-group)))) {
            groups.delete(group)
          }
        }
        if (groups.size === 0 && alive.size === 0) return
        yield* Effect.sleep("50 millis")
      }
    }
    return yield* error(
      unverified ?? (waitOnly.size > 0
        ? "Signal ownership or permission changed and process group exit was not verified; recovery refused"
        : "Owned process group did not exit after SIGKILL; recovery refused"),
    )
  },
)
