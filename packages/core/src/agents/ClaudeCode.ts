import { query } from "@anthropic-ai/claude-agent-sdk"
import { Effect, identity, Option, Ref, Schema, Stream } from "effect"
import type { AgentAdapter } from "../Agents.js"
import type { AgentInput } from "../domain/Agent.js"
import type { AgentEvent } from "../domain/AgentEvent.js"
import { AgentCrashed, AgentProtocolError, AgentSpawnError } from "../domain/Errors.js"

const otherThan = (...types: ReadonlyArray<string>) =>
  Schema.String.check(Schema.makeFilter((type) => !types.includes(type)))
const errorSubtype = Schema.String.check(Schema.isPattern(/^error_/))
const otherResult = Schema.String.check(Schema.makeFilter((type) => type !== "success" && !type.startsWith("error_")))
const AssistantBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool_use"), id: Schema.String, name: Schema.String, input: Schema.Unknown }),
  Schema.Struct({ type: otherThan("text", "tool_use") }),
])
const UserBlock = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    tool_use_id: Schema.String,
    is_error: Schema.optional(Schema.Boolean),
    content: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ type: otherThan("tool_result") }),
])
const SdkMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("system"), subtype: Schema.Literal("init"), session_id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("api_retry"),
    attempt: Schema.Int,
    error: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("system"), subtype: otherThan("init", "api_retry") }),
  Schema.Struct({
    type: Schema.Literal("assistant"),
    message: Schema.Struct({
      content: Schema.Array(AssistantBlock),
      usage: Schema.optional(Schema.Struct({ input_tokens: Schema.Int, output_tokens: Schema.Int })),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("user"),
    message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(UserBlock)]) }),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.Literal("success"),
    is_error: Schema.Boolean,
    result: Schema.String,
    total_cost_usd: Schema.Finite,
    num_turns: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: errorSubtype,
    is_error: Schema.Boolean,
    result: Schema.optional(Schema.String),
    total_cost_usd: Schema.Finite,
    num_turns: Schema.Int,
  }),
  Schema.Struct({ type: Schema.Literal("result"), subtype: otherResult }),
  Schema.Struct({ type: otherThan("system", "assistant", "user", "result") }),
])

export const fromSdkMessage = Effect.fnUntraced(
  function*(message: unknown): Effect.fn.Return<ReadonlyArray<AgentEvent>, AgentProtocolError> {
    const decoded = yield* Schema.decodeUnknownEffect(SdkMessage)(message).pipe(
      Effect.mapError((schemaError) =>
        new AgentProtocolError({
          agent: "claude-code",
          line: JSON.stringify(message) ?? String(message),
          issue: schemaError.message,
        })
      ),
    )
    const events: Array<AgentEvent> = []
    if ("session_id" in decoded) {
      events.push({ _tag: "Started", sessionId: decoded.session_id })
    } else if ("attempt" in decoded) {
      events.push({ _tag: "Retry", attempt: decoded.attempt, reason: decoded.error })
    } else if ("message" in decoded) {
      if (typeof decoded.message.content !== "string") {
        for (const block of decoded.message.content) {
          if ("text" in block) {
            events.push({ _tag: "Text", text: block.text })
          } else if ("input" in block) {
            events.push({ _tag: "ToolCall", id: block.id, name: block.name, input: block.input })
          } else if ("tool_use_id" in block) {
            events.push({
              _tag: "ToolResult",
              id: block.tool_use_id,
              isError: block.is_error ?? false,
              summary: typeof block.content === "string" ? block.content : JSON.stringify(block.content) ?? "",
            })
          } else {
            yield* Effect.logDebug("Dropped Claude content block", block.type)
          }
        }
      }
      if ("usage" in decoded.message && decoded.message.usage !== undefined) {
        events.push({
          _tag: "Usage",
          inputTokens: decoded.message.usage.input_tokens,
          outputTokens: decoded.message.usage.output_tokens,
        })
      }
    } else if ("is_error" in decoded) {
      if (decoded.is_error || decoded.subtype.startsWith("error_")) {
        events.push({ _tag: "Failed", reason: decoded.result ?? decoded.subtype })
      } else {
        events.push({
          _tag: "Completed",
          result: decoded.result ?? "",
          costUsd: decoded.total_cost_usd,
          turns: decoded.num_turns,
        })
      }
    } else {
      yield* Effect.logDebug("Dropped Claude SDK message", decoded)
    }
    return events
  },
)

export const make = (deps: { readonly query: typeof query }): AgentAdapter => {
  const run = Effect.fn("ClaudeCode.run")(function*(input: AgentInput) {
    const abortController = yield* Effect.sync(() => new AbortController())
    const model = Option.getOrUndefined(input.model)
    const maxTurns = Option.getOrUndefined(input.maxTurns)
    const maxBudgetUsd = Option.getOrUndefined(input.maxBudgetUsd)
    const handle = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          deps.query({
            prompt: input.prompt,
            options: {
              cwd: input.cwd,
              permissionMode: "dontAsk",
              settingSources: input.loadProjectSettings ? ["project", "local"] : [],
              allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
              disallowedTools: [
                "Bash(git worktree *)",
                "Bash(git checkout *)",
                "Bash(git switch *)",
                "Bash(git push *)",
                "AskUserQuestion",
              ],
              ...(model === undefined ? {} : { model }),
              ...(maxTurns === undefined ? {} : { maxTurns }),
              ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
              abortController,
            },
          }),
        catch: (cause) => new AgentSpawnError({ agent: "claude-code", cause }),
      }),
      (handle) =>
        Effect.sync(() => {
          abortController.abort()
          handle.close()
        }),
    )
    const last = yield* Ref.make(Option.none<AgentEvent>())
    const crashed = Effect.flatMap(
      Ref.get(last),
      (lastEvent) => Effect.fail(new AgentCrashed({ agent: "claude-code", exitCode: -1, lastEvent })),
    )
    const isTerminal = (event: AgentEvent) => event._tag === "Completed" || event._tag === "Failed"
    return Stream.fromAsyncIterable(handle, identity).pipe(
      Stream.catch(() => Stream.fromEffect(crashed)),
      Stream.mapEffect(fromSdkMessage),
      Stream.flattenIterable,
      Stream.tap((event) => Ref.set(last, Option.some(event))),
      Stream.takeUntil(isTerminal),
      Stream.concat(
        Stream.fromEffect(Ref.get(last)).pipe(
          Stream.flatMap((lastEvent) =>
            Option.exists(lastEvent, isTerminal) ? Stream.empty : Stream.fromEffect(crashed)
          ),
        ),
      ),
    )
  })
  return {
    id: "claude-code",
    capabilities: { maxTurns: true, maxBudgetUsd: true, model: true, costReporting: true },
    run: (input) => Stream.unwrap(run(input)),
  }
}

export const adapter = make({ query })
