import {
  AgentCrashed,
  AgentEvent,
  AgentProtocolError,
  Agents,
  AgentSpawnError,
  ClaudeCode,
  Pi,
  retryableSpawnError,
  SetupError,
  stopProcessGroup,
  TaskId,
} from "@agentrun/core"
import type { AgentAdapter, AgentError, AgentInput } from "@agentrun/core"
import { NodeStream } from "@effect/platform-node"
import { Cause, Effect, FileSystem, Layer, Option, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { diagnostic } from "./ui/output.js"

const WireInput = Schema.Struct({
  taskId: Schema.optional(TaskId),
  agent: Schema.Literals(["claude-code", "pi"]),
  prompt: Schema.String,
  cwd: Schema.String,
  model: Schema.optional(Schema.String),
  maxTurns: Schema.optional(Schema.Finite),
  maxBudgetUsd: Schema.optional(Schema.Finite),
  setup: Schema.optional(Schema.String),
  loadProjectSettings: Schema.Boolean,
})

const WireError = Schema.Union([
  SetupError,
  AgentProtocolError,
  Schema.Struct({
    _tag: Schema.Literal("AgentSpawnError"),
    agent: Schema.Literals(["claude-code", "pi"]),
    cause: Schema.String,
    retryable: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    _tag: Schema.Literal("AgentCrashed"),
    agent: Schema.Literals(["claude-code", "pi"]),
    exitCode: Schema.Int,
  }),
])
const WireMessage = Schema.Union([
  Schema.TaggedStruct("WorkerSetupCompleted", {}),
  AgentEvent,
  Schema.Struct({ _tag: Schema.Literal("WorkerError"), error: WireError }),
])
const fromWire = (error: typeof WireError.Type): AgentError => {
  switch (error._tag) {
    case "SetupError":
      return error
    case "AgentProtocolError":
      return error
    case "AgentSpawnError":
      return new AgentSpawnError(error)
    case "AgentCrashed":
      return new AgentCrashed({ ...error, lastEvent: Option.none() })
  }
}

export const workerAgents = (worker: URL) =>
  Layer.succeed(Agents, {
    get: (id) =>
      Option.some(
        {
          id,
          capabilities: (id === "pi" ? Pi.adapter : ClaudeCode.adapter).capabilities,
          run: (input) =>
            Stream.unwrap(Effect.gen(function*() {
              const token = randomBytes(16).toString("hex")
              const error = (cause: unknown) => new AgentSpawnError({ agent: id, cause })
              const child = yield* Effect.acquireRelease(
                Effect.try({
                  try: () =>
                    spawn(process.execPath, [fileURLToPath(worker), `agentrun-worker-${token}`], {
                      cwd: input.cwd,
                      detached: true,
                      stdio: ["pipe", "pipe", "pipe"],
                    }),
                  catch: error,
                }),
                (child) =>
                  child.pid === undefined ? Effect.void : stopProcessGroup(child.pid, token).pipe(Effect.orDie),
              )
              if (child.pid === undefined) return yield* error("Worker did not start")
              // Capture errors before persistence; never start the provider before its ownership is saved.
              child.on("error", () => {})
              child.stderr.setEncoding("utf8")
              child.stderr.on("data", (chunk: string) => diagnostic(chunk, input.taskId))
              if (input.registerProcess === undefined) {
                return yield* error("Worker requires durable process registration")
              }
              yield* input.registerProcess(child.pid, token)
              const encoded = {
                agent: id,
                taskId: input.taskId,
                cwd: input.cwd,
                prompt: input.prompt,
                model: Option.getOrUndefined(input.model),
                maxTurns: Option.getOrUndefined(input.maxTurns),
                maxBudgetUsd: Option.getOrUndefined(input.maxBudgetUsd),
                setup: input.setup,
                loadProjectSettings: input.loadProjectSettings === true,
              }
              const protocolError = (cause: unknown) =>
                new AgentProtocolError({ agent: id, line: "", issue: String(cause) })
              const lines = NodeStream.fromReadable({ evaluate: () => child.stdout, onError: protocolError })
                .pipe(Stream.decodeText(), Stream.splitLines)
              const last = yield* Ref.make(Option.none<AgentEvent>())
              child.stdin.on("error", () => {})
              child.stdin.end(`${JSON.stringify(encoded)}\n`)
              return lines.pipe(
                Stream.mapEffect((line) => Effect.try({ try: (): unknown => JSON.parse(line), catch: protocolError })),
                Stream.mapEffect((event) =>
                  Schema.decodeUnknownEffect(WireMessage)(event).pipe(Effect.mapError(protocolError))
                ),
                Stream.mapEffect((message) => {
                  if (message._tag === "WorkerError") return Effect.fail(fromWire(message.error))
                  if (message._tag === "WorkerSetupCompleted") {
                    return (input.setupCompleted?.() ?? Effect.void).pipe(Effect.as(Option.none<AgentEvent>()))
                  }
                  return Effect.succeed(Option.some(message))
                }),
                Stream.filter(Option.isSome),
                Stream.map((event) => event.value),
                Stream.tap((event) => Ref.set(last, Option.some(event))),
                Stream.takeUntil((event) => event._tag === "Completed" || event._tag === "Failed"),
                Stream.concat(
                  Stream.fromEffect(Ref.get(last)).pipe(Stream.flatMap((lastEvent) =>
                    Option.exists(lastEvent, (event) => event._tag === "Completed" || event._tag === "Failed")
                      ? Stream.empty
                      : Stream.fail(new AgentCrashed({ agent: id, exitCode: child.exitCode ?? -1, lastEvent }))
                  )),
                ),
              )
            })),
        } satisfies AgentAdapter,
      ),
  })

// The worker waits on stdin. Its group is recorded before setup or tools start.
export const serveWorker = (
  run: (input: AgentInput, agent: "claude-code" | "pi") => ReturnType<AgentAdapter["run"]>,
) => {
  let agent: "claude-code" | "pi" = "claude-code"
  const protocolError = (cause: unknown) => new AgentProtocolError({ agent, line: "", issue: String(cause) })
  const send = (value: unknown) =>
    Effect.sync(() => {
      process.stdout.write(`${JSON.stringify(value)}\n`)
    })
  const main = Effect.gen(function*() {
    // Reader closure must not kill the group leader before the owner stops its children.
    const outputError = (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.stdout.on("error", outputError)
      }),
      () =>
        Effect.sync(() => {
          process.stdout.off("error", outputError)
        }),
    )
    const first = yield* NodeStream.fromReadable({ evaluate: () => process.stdin, onError: protocolError })
      .pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
    if (Option.isNone(first)) return
    const parsed = yield* Effect.try({ try: (): unknown => JSON.parse(first.value), catch: protocolError })
    const wire = yield* Schema.decodeUnknownEffect(WireInput)(parsed).pipe(Effect.mapError(protocolError))
    agent = wire.agent
    const input: AgentInput = {
      workerProcessGroup: true,
      ...(wire.taskId === undefined ? {} : { taskId: wire.taskId }),
      prompt: wire.prompt,
      cwd: wire.cwd,
      loadProjectSettings: wire.loadProjectSettings,
      ...(wire.setup === undefined ? {} : { setup: wire.setup }),
      model: Option.fromUndefinedOr(wire.model),
      maxTurns: Option.fromUndefinedOr(wire.maxTurns),
      maxBudgetUsd: Option.fromUndefinedOr(wire.maxBudgetUsd),
    }
    const command = wire.setup
    if (command !== undefined) {
      const taskId = wire.taskId
      if (taskId === undefined) return yield* protocolError("Setup requires task identity")
      yield* Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fs = yield* FileSystem.FileSystem
        const stderrFile = yield* fs.makeTempFileScoped({ prefix: "agentrun-setup-" })
        // A file captures stderr without waiting for background children to close inherited pipes.
        const setup = yield* spawner.spawn(
          ChildProcess.make("sh", ["-c", "exec 2>\"$1\"; eval \"$2\"", "sh", stderrFile, command], {
            cwd: wire.cwd,
            detached: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
        const exitCode = yield* setup.exitCode
        const stderr = yield* fs.readFileString(stderrFile)
        if (exitCode !== 0) return yield* new SetupError({ taskId, command, exitCode, stderr })
      })).pipe(
        Effect.mapError((error) =>
          error._tag === "SetupError" ? error : new SetupError({ taskId, command, exitCode: -1, stderr: error.message })
        ),
      )
    }
    yield* send({ _tag: "WorkerSetupCompleted" })
    yield* Stream.runForEach(run(input, wire.agent), send)
    return yield* Effect.never
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      send({
        _tag: "WorkerError",
        error: error._tag === "AgentSpawnError"
          ? { ...error, retryable: retryableSpawnError(error), cause: String(error.cause) }
          : error,
      }).pipe(Effect.andThen(Effect.never))
    ),
    Effect.catchCause((cause) =>
      send({ _tag: "WorkerError", error: protocolError(Cause.pretty(cause)) }).pipe(Effect.andThen(Effect.never))
    ),
  )
  return main
}
