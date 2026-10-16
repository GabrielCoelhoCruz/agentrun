import { stopProcessGroup } from "@agentrun/core"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CommandSpec, failure, Id, ownershipFailure, ProcessResult } from "./Domain.js"
import type { AttemptState, OwnedProcess } from "./Domain.js"
import { io, readBytes, readJson, sha256 } from "./Files.js"
import { blob, Store } from "./Store.js"

// Longer than an executor needs to stop its own workers after SIGTERM.
export const stopGraceMs = 10000
export const Launch = Schema.Struct({
  attemptId: Id,
  token: Schema.String,
  commandHash: Schema.String,
  directory: Schema.String,
  command: CommandSpec,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
})
export const CommandGroup = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: Id,
  token: Schema.String,
  commandHash: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(1)),
  pgid: Schema.Int.check(Schema.isGreaterThan(1)),
})
const alive = (pid: number) =>
  io("process", () => {
    try {
      process.kill(pid, 0)
      return true
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") return false
      throw cause
    }
  })
export const receipt = (owned: OwnedProcess, attemptId: string) =>
  io("process", async () => {
    const file = join(owned.directory, "result.json")
    if (!existsSync(file)) return undefined
    const result = Schema.decodeUnknownSync(ProcessResult, { onExcessProperty: "error" })(await readJson(file))
    if (
      result.pid !== owned.pid || result.token !== owned.token || result.commandHash !== owned.commandHash
      || result.attemptId !== attemptId
    ) throw failure("process", "Process result belongs to another attempt or owner")
    return result
  })
export const stop = (store: Store, attemptId: string, owned: OwnedProcess, reason: string) =>
  Effect.gen(function*() {
    yield* stopProcessGroup(owned.pid, owned.token, "factory").pipe(Effect.mapError((error) =>
      ownershipFailure(
        "Process ownership could not be verified. Preserve the attempt and inspect its processes.",
        error,
      )
    ))
    const commandGroup = yield* io("process-ownership", async () => {
      const file = join(owned.directory, "command-group.json")
      if (!existsSync(file)) {
        if (existsSync(join(owned.directory, "started.json")) && !existsSync(join(owned.directory, "result.json"))) {
          throw failure("process-ownership", "Command group identity is missing; cleanup refused")
        }
        return undefined
      }
      const group = Schema.decodeUnknownSync(CommandGroup, { onExcessProperty: "error" })(await readJson(file))
      if (
        group.pid !== owned.pid || group.token !== owned.token || group.commandHash !== owned.commandHash
        || group.attemptId !== attemptId || group.pgid === owned.pid
      ) throw failure("process-ownership", "Command group identity differs from its owner; cleanup refused")
      return group
    })
    if (commandGroup !== undefined) {
      yield* stopProcessGroup(commandGroup.pgid, owned.token, "factory").pipe(
        Effect.mapError((error) =>
          ownershipFailure("Command group ownership could not be verified; cleanup refused", error)
        ),
      )
    }
    const state = yield* store.read()
    if (
      state.current?.attempt.id === attemptId && state.current.process?.pid === owned.pid
      && state.current.process.token === owned.token && !state.current.stopped
    ) {
      yield* store.append({ _tag: "ProcessStopped", attemptId, generation: owned.generation, reason })
    }
  })

export const collectProcess = (store: Store, current: AttemptState, result: ProcessResult) =>
  Effect.gen(function*() {
    const owned = current.process
    if (owned === undefined) return yield* failure("process", "Process receipt has no registered owner")
    const blobs = yield* io("artifact", () =>
      Promise.all(["stdout.log", "stderr.log", "started.json", "result.json"].map(async (name) => ({
        name,
        value: blob(await readBytes(join(owned.directory, name))),
      }))))
    yield* store.append(
      {
        _tag: "ProcessCompleted",
        attemptId: current.attempt.id,
        generation: owned.generation,
        result,
        artifacts: blobs.map(({ name, value }) => ({
          name: `${current.attempt.id}/${owned.generation}/${name}`,
          digest: value.digest,
        })),
      },
      blobs.map(({ value }) =>
        value
      ),
    )
  })

export const runProcess = (
  store: Store,
  current: AttemptState,
  command: typeof CommandSpec.Type,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) =>
  Effect.gen(function*() {
    const attemptId = current.attempt.id
    const generation = (current.process?.generation ?? 0) + 1
    const token = randomBytes(16).toString("hex")
    const directory = join(store.directory, "processes", attemptId, String(generation))
    const commandHash = sha256(JSON.stringify(command))
    yield* io("process", () => mkdirSync(directory, { recursive: true, mode: 0o700 }))
    const result = yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* Effect.acquireRelease(
        io("process", () =>
          spawn(process.execPath, [
            fileURLToPath(new URL("./supervisor.mjs", import.meta.url)),
            `agentrun-factory-${token}`,
          ], {
            cwd: command.cwd,
            env,
            detached: true,
            stdio: ["pipe", "ignore", "ignore"],
          })),
        (child) =>
          child.pid === undefined
            ? Effect.void
            : stop(
              store,
              attemptId,
              { pid: child.pid, token, generation, directory, commandHash, command },
              "Command scope ended",
            ).pipe(Effect.orDie),
      )
      child.on("error", () => {})
      child.stdin.on("error", () => {})
      if (child.pid === undefined) {
        return yield* failure("process", "Command supervisor did not start")
      }
      const owned: OwnedProcess = { pid: child.pid, token, generation, directory, commandHash, command }
      yield* store.append({ _tag: "ProcessRegistered", attemptId, process: owned })
      yield* store.append({ _tag: "DispatchReleased", attemptId, generation, kind: current.attempt.kind })
      child.stdin.end(`${JSON.stringify({ attemptId, token, commandHash, directory, command, timeoutMs })}\n`)
      while (true) {
        const found = yield* receipt(owned, attemptId)
        if (found !== undefined) return found
        if (!(yield* alive(owned.pid))) {
          return yield* failure(
            "unknown-outcome",
            "Command supervisor exited without a terminal receipt. Its effects are unknown.",
          )
        }
        yield* Effect.sleep("50 millis")
      }
    })).pipe(Effect.timeoutOrElse({
      duration: timeoutMs + stopGraceMs + 10000,
      orElse: () =>
        Effect.fail(
          failure(
            "unknown-outcome",
            "Command exceeded its receipt deadline. Owned cleanup ran; the outcome needs inspection.",
          ),
        ),
    }))
    const latest = (yield* store.read()).current
    if (latest === undefined || latest.attempt.id !== attemptId) {
      return yield* failure("state", "Process completion belongs to an old attempt")
    }
    yield* collectProcess(store, latest, result)
    return result
  })

export const recoverProcess = (store: Store, current: AttemptState) =>
  Effect.gen(function*() {
    const owned = current.process
    if (owned === undefined) return "not-started" as const
    if (current.result !== undefined) {
      if (!current.stopped) yield* stop(store, current.attempt.id, owned, "Recovered terminal process")
      return "completed" as const
    }
    const result = yield* receipt(owned, current.attempt.id)
    if (result !== undefined) {
      if (!current.stopped) yield* stop(store, current.attempt.id, owned, "Recovered terminal receipt")
      yield* collectProcess(store, current, result)
      return "completed" as const
    }
    const started = yield* io("process", () => existsSync(join(owned.directory, "started.json")))
    if (!started) {
      if (!current.stopped) yield* stop(store, current.attempt.id, owned, "Recovered unopened launch gate")
      const settled = yield* io("process", () => existsSync(join(owned.directory, "started.json")))
      if (!settled) return "not-started" as const
      const result = yield* receipt(owned, current.attempt.id)
      if (result !== undefined) {
        yield* collectProcess(store, current, result)
        return "completed" as const
      }
    }
    if (!current.stopped && !(yield* alive(owned.pid))) {
      yield* stop(store, current.attempt.id, owned, "Recovered dead supervisor")
    }
    return "unknown" as const
  })
