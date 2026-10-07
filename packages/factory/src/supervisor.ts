import { Clock, Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { join } from "node:path"
import { failure, ProcessResult } from "./Domain.js"
import { io, sha256, writeExclusive } from "./Files.js"
import { Launch } from "./Processes.js"

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
      spawn(launch.command.argv[0], launch.command.argv.slice(1), {
        cwd: launch.command.cwd,
        env: process.env,
        stdio: ["ignore", files.stdout, files.stderr],
      }))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      process.kill(-process.pid, "SIGTERM")
      setTimeout(() => {
        if (!complete) process.kill(-process.pid, "SIGKILL")
      }, 2000).unref()
    }, launch.timeoutMs)
    const result = yield* Effect.callback<{ exitCode: number | null; signal: string | null }, never>((resume) => {
      child.once("error", () => resume(Effect.succeed({ exitCode: -1, signal: null })))
      child.once(
        "exit",
        (exitCode, signal) => resume(Effect.succeed({ exitCode, signal: timedOut ? "TIMEOUT" : signal })),
      )
    }).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))
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
