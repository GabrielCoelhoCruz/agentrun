import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent"
import { Effect, Option, Queue, Schema, Stream } from "effect"
import { join } from "node:path"
import type { AgentAdapter } from "../Agents.js"
import type { AgentInput } from "../domain/Agent.js"
import type { AgentEvent } from "../domain/AgentEvent.js"
import { AgentCrashed, AgentProtocolError, AgentSpawnError } from "../domain/Errors.js"
import type { AgentError } from "../domain/Errors.js"

export interface Session {
  readonly sessionId: string
  readonly subscribe: (listener: (event: unknown) => void) => () => void
  readonly prompt: (text: string) => Promise<void>
  readonly abort: () => Promise<void>
  readonly dispose: () => void
}

const otherThan = (...types: ReadonlyArray<string>) =>
  Schema.String.check(Schema.makeFilter((type) => !types.includes(type)))
const Block = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: otherThan("text") }),
])
const SdkEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message_end"),
    message: Schema.Union([
      Schema.Struct({
        role: Schema.Literal("assistant"),
        content: Schema.Array(Block),
        usage: Schema.Struct({
          input: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          output: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          cost: Schema.Struct({ total: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)) }),
        }),
        stopReason: Schema.Literals(["stop", "length", "toolUse", "error", "aborted"]),
        errorMessage: Schema.optional(Schema.String),
      }),
      Schema.Struct({ role: otherThan("assistant") }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    isError: Schema.Boolean,
    result: Schema.Struct({ content: Schema.Array(Block) }),
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_start"),
    attempt: Schema.Int,
    errorMessage: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_end"),
    success: Schema.Boolean,
    attempt: Schema.Int,
    finalError: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("error"), error: Schema.String }),
  Schema.Struct({ type: Schema.Literal("agent_settled") }),
  Schema.Struct({
    type: otherThan(
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "auto_retry_start",
      "auto_retry_end",
      "error",
      "agent_settled",
    ),
  }),
])

const setup = Effect.fn("Pi.setup")(function*(input: AgentInput) {
  const spawnError = (cause: unknown) => new AgentSpawnError({ agent: "pi", cause })
  if (Option.isSome(input.maxTurns) || Option.isSome(input.maxBudgetUsd)) {
    return yield* spawnError(new Error("Pi does not support maxTurns or maxBudgetUsd"))
  }
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.inMemory()
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // noContextFiles only excludes AGENTS.md; skip SYSTEM.md and APPEND_SYSTEM.md too.
    systemPrompt: "",
    systemPromptOverride: () => undefined,
    appendSystemPrompt: [],
  })
  yield* Effect.tryPromise({ try: () => resourceLoader.reload(), catch: spawnError })
  const options: CreateAgentSessionOptions = {
    cwd: input.cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(input.cwd),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  }
  if (Option.isSome(input.model)) {
    const reference = input.model.value
    const separator = reference.indexOf("/")
    if (separator < 1 || separator === reference.length - 1) {
      return yield* spawnError(new Error("Pi model must be provider/modelId"))
    }
    const modelRuntime = yield* Effect.tryPromise({
      try: () =>
        ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }),
      catch: spawnError,
    })
    const model = modelRuntime.getModel(reference.slice(0, separator), reference.slice(separator + 1))
    if (model === undefined) return yield* spawnError(new Error(`Unknown Pi model: ${reference}`))
    return { ...options, modelRuntime, model }
  }
  return options
})

type Signal =
  | { readonly _tag: "Started"; readonly sessionId: string }
  | { readonly _tag: "Event"; readonly event: unknown }
  | { readonly _tag: "PromptEnd" }
  | { readonly _tag: "PromptRejected" }

export const make = (deps: {
  readonly createAgentSession: (options: CreateAgentSessionOptions) => Promise<{ readonly session: Session }>
}): AgentAdapter => ({
  id: "pi",
  capabilities: { maxTurns: false, maxBudgetUsd: false, model: true, costReporting: true },
  run: (input) =>
    Stream.suspend(() => {
      let last = Option.none<AgentEvent>()
      let failure: string | undefined
      let result = ""
      let costUsd = 0
      let turns = 0
      let promptFinished = Promise.resolve()
      const crashed = () => new AgentCrashed({ agent: "pi", exitCode: -1, lastEvent: last })
      const source = Stream.callback<Signal, AgentError>(Effect.fnUntraced(function*(queue) {
        const options = yield* setup(input)
        const session = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => deps.createAgentSession(options),
            catch: (cause) => new AgentSpawnError({ agent: "pi", cause }),
          }).pipe(Effect.map(({ session }) => session)),
          (session) =>
            Effect.promise(() => session.abort()).pipe(
              Effect.andThen(Effect.promise(() => promptFinished)),
              Effect.ensuring(Effect.sync(() => session.dispose())),
            ),
        )
        Queue.offerUnsafe(queue, { _tag: "Started", sessionId: session.sessionId })
        yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              session.subscribe((event) => {
                Queue.offerUnsafe(queue, { _tag: "Event", event })
              }),
            catch: (cause) => new AgentSpawnError({ agent: "pi", cause }),
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        )
        yield* Effect.try({
          try: () => {
            promptFinished = session.prompt(input.prompt).then(
              () => {
                Queue.offerUnsafe(queue, { _tag: "PromptEnd" })
              },
              () => {
                Queue.offerUnsafe(queue, { _tag: "PromptRejected" })
              },
            )
          },
          catch: crashed,
        }).pipe(Effect.catch(() => Queue.offer(queue, { _tag: "PromptRejected" })))
      }, (effect, queue) => effect.pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause)))))
      const normalize = Effect.fnUntraced(
        function*(signal: Signal): Effect.fn.Return<ReadonlyArray<AgentEvent>, AgentError> {
          if (signal._tag === "Started") return [{ _tag: "Started", sessionId: signal.sessionId }]
          if (signal._tag !== "Event") return yield* crashed()
          const event = yield* Schema.decodeUnknownEffect(SdkEvent)(signal.event).pipe(
            Effect.mapError((error) =>
              new AgentProtocolError({ agent: "pi", line: "SDK event", issue: error.message })
            ),
          )
          if ("message" in event) {
            if (!("content" in event.message)) return []
            const message = event.message
            const text = message.content.flatMap((block) => "text" in block ? [block.text] : []).join("\n")
            result = text
            costUsd += message.usage.cost.total
            turns++
            if (message.stopReason === "error" || message.stopReason === "aborted") {
              failure = message.errorMessage ?? message.stopReason
            }
            return [
              ...(text.length === 0 ? [] : [{ _tag: "Text", text } satisfies AgentEvent]),
              {
                _tag: "Usage",
                inputTokens: message.usage.input,
                outputTokens: message.usage.output,
                costUsd: message.usage.cost.total,
              },
            ]
          }
          if ("args" in event) {
            return [{ _tag: "ToolCall", id: event.toolCallId, name: event.toolName, input: event.args }]
          }
          if ("result" in event) {
            return [{
              _tag: "ToolResult",
              id: event.toolCallId,
              isError: event.isError,
              summary: event.result.content.flatMap((block) => "text" in block ? [block.text] : []).join("\n"),
            }]
          }
          if ("errorMessage" in event) {
            return [{ _tag: "Retry", attempt: event.attempt, reason: event.errorMessage }]
          }
          if ("success" in event) {
            failure = event.success ? undefined : event.finalError ?? "Automatic retry failed"
            return []
          }
          if ("error" in event) {
            failure = event.error
            return []
          }
          if (event.type === "agent_settled") {
            return failure === undefined
              ? [{ _tag: "Completed", result, costUsd, turns }]
              : [{ _tag: "Failed", reason: failure }]
          }
          yield* Effect.logDebug("Dropped Pi SDK event", event.type)
          return []
        },
      )
      return source.pipe(
        Stream.mapEffect(normalize),
        Stream.flattenIterable,
        Stream.tap((event) =>
          Effect.sync(() => {
            last = Option.some(event)
          })
        ),
        Stream.takeUntil((event) => event._tag === "Completed" || event._tag === "Failed"),
      )
    }),
})

export const adapter = make({ createAgentSession })
