import { stopProcessGroup } from "@agentrun/core"
import { Clock, Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { closeSync, linkSync, openSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { failure, ProcessResult } from "./Domain.js"
import { io, sha256, syncDirectory, writeExclusive } from "./Files.js"
import { Launch, stopGraceMs } from "./Processes.js"

let running = false
let complete = false
setInterval(() => {}, 1000)
process.on("SIGTERM", () => {
  if (!running || complete) process.exit(0)
})
const serve = Effect.gen(function*() {
  const input = yield* Effect.callback<string, never>((resume) => {
    let buffer = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (data: string) => {
      buffer += data
      if (buffer.length > 1024 * 1024) process.exit(1)
    })
    process.stdin.once("end", () => resume(Effect.succeed(buffer)))
    process.stdin.resume()
  })
  if (input.trim() === "") process.exit(0)
  const launch = yield* io(
    "process",
    () => Schema.decodeUnknownSync(Launch, { onExcessProperty: "error" })(JSON.parse(input)),
  )
  if (
    !process.argv.includes(`agentrun-factory-${launch.token}`)
    || sha256(JSON.stringify(launch.command)) !== launch.commandHash
  ) return yield* failure("process", "Launch identity differs from its owner")
  const startedAt = yield* Clock.currentTimeMillis
  const identity = {
    version: 1 as const,
    attemptId: launch.attemptId,
    token: launch.token,
    commandHash: launch.commandHash,
    pid: process.pid,
  }
  yield* io(
    "process",
    () => writeExclusive(join(launch.directory, "started.json"), JSON.stringify({ ...identity, startedAt })),
  )
  running = true
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const files = yield* Effect.acquireRelease(
      io(
        "process",
        () => ({
          stdout: openSync(join(launch.directory, "stdout.log"), "wx", 0o600),
          stderr: openSync(join(launch.directory, "stderr.log"), "wx", 0o600),
        }),
      ),
      (files) =>
        Effect.sync(() => {
          closeSync(files.stdout)
          closeSync(files.stderr)
        }),
    )
    const child = yield* io("process", () =>
      spawn(process.execPath, [
        fileURLToPath(new URL("./command.mjs", import.meta.url)),
        `agentrun-factory-${launch.token}`,
      ], {
        cwd: launch.command.cwd,
        env: process.env,
        detached: true,
        stdio: ["pipe", files.stdout, files.stderr, "ipc"],
      }))
    child.on("error", () => {})
    if (child.stdin === null) return yield* failure("process", "Command group has no launch gate")
    const gate = child.stdin
    gate.on("error", () => {})
    if (child.pid === undefined) return yield* failure("process", "Command group did not start")
    yield* io("process", async () => {
      const temporary = join(launch.directory, "command-group.pending")
      await writeExclusive(temporary, JSON.stringify({ ...identity, pgid: child.pid }))
      linkSync(temporary, join(launch.directory, "command-group.json"))
      syncDirectory(launch.directory)
      unlinkSync(temporary)
      syncDirectory(launch.directory)
    })
    // The command leads its own group, so a timeout signal never reaches this supervisor.
    const signalCommand = (signal: NodeJS.Signals | 0) => {
      if (child.pid === undefined) return false
      try {
        process.kill(-child.pid, signal)
        return true
      } catch {
        return false
      }
    }
    let timedOut = false
    let killAt = 0
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      killAt = Date.now() + stopGraceMs
      signalCommand("SIGTERM")
      killTimer = setTimeout(() => signalCommand("SIGKILL"), stopGraceMs)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = yield* Effect.callback<{ exitCode: number | null; signal: string | null }, never>((resume) => {
      child.on("message", (message) => {
        if (message === "started") {
          timer = setTimeout(() => {
            timedOut = true
            terminate()
          }, launch.timeoutMs)
          return
        }
        const result = Schema.decodeUnknownSync(Schema.Struct({
          exitCode: Schema.NullOr(Schema.Int),
          signal: Schema.NullOr(Schema.String),
        }))(message)
        resume(Effect.succeed({ ...result, signal: timedOut ? "TIMEOUT" : result.signal }))
      })
      child.once("error", () => resume(Effect.succeed({ exitCode: -1, signal: null })))
      child.once(
        "exit",
        (exitCode, signal) => resume(Effect.succeed({ exitCode, signal: timedOut ? "TIMEOUT" : signal })),
      )
      gate.end(JSON.stringify(launch.command))
    }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))
    // Processes left in the command's group stop before the receipt is written.
    if (!timedOut) {
      yield* stopProcessGroup(child.pid, launch.token, "factory").pipe(
        Effect.mapError((error) => failure("process-ownership", String(error))),
      )
    } else if (signalCommand(0)) {
      if (killAt === 0) terminate()
      while (signalCommand(0) && Date.now() < killAt + 2000) yield* Effect.sleep("50 millis")
    }
    clearTimeout(killTimer)
    return result
  }))
  const terminal: ProcessResult = {
    ...identity,
    startedAt,
    durationMs: Math.max(0, Math.floor((yield* Clock.currentTimeMillis) - startedAt)),
    ...result,
  }
  yield* io("process", () => writeExclusive(join(launch.directory, "result.json"), JSON.stringify(terminal)))
})
Effect.runPromise(serve).then(() => {
  complete = true
}, () => {
  complete = true
  process.exit(1)
})
