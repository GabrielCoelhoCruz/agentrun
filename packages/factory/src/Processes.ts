import { stopProcessGroup } from "@agentrun/core"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CommandSpec, failure, Id, ProcessResult } from "./Domain.js"
import type { AttemptState, OwnedProcess } from "./Domain.js"
import { io, readBytes, readJson, sha256 } from "./Files.js"
import { blob, Store } from "./Store.js"

export const Launch = Schema.Struct({
  attemptId: Id,
  token: Schema.String,
  commandHash: Schema.String,
  directory: Schema.String,
  command: CommandSpec,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
})
export const receipt = (owned: OwnedProcess, attemptId: string) =>
  io("process", () => {
    const file = join(owned.directory, "result.json")
    if (!existsSync(file)) return undefined
    const result = Schema.decodeUnknownSync(ProcessResult, { onExcessProperty: "error" })(readJson(file))
    if (
      result.pid !== owned.pid || result.token !== owned.token || result.commandHash !== owned.commandHash
      || result.attemptId !== attemptId
    ) throw failure("process", "Process result belongs to another attempt or owner")
    return result
  })
export const stop = (store: Store, attemptId: string, owned: OwnedProcess, reason: string) =>
  Effect.gen(function*() {
    yield* stopProcessGroup(owned.pid, owned.token, "factory").pipe(Effect.mapError(() =>
      failure(
        "process-ownership",
        "Process ownership could not be verified. Preserve the attempt and inspect its processes.",
      )
    ))
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
      ["stdout.log", "stderr.log", "started.json", "result.json"].map((name) => ({
        name,
        value: blob(readBytes(join(owned.directory, name))),
      })))
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
      blobs.map(({ value }) => value),
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
        const alive = yield* io("process", () => {
          try {
            process.kill(owned.pid, 0)
            return true
          } catch (cause) {
            if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") return false
            throw cause
          }
        })
        if (!alive) {
          return yield* failure(
            "unknown-outcome",
            "Command supervisor exited without a terminal receipt. Its effects are unknown.",
          )
        }
        yield* Effect.sleep("50 millis")
      }
    })).pipe(Effect.timeoutOrElse({
      duration: timeoutMs + 10000,
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
    return "unknown" as const
  })
