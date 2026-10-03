import { query } from "@anthropic-ai/claude-agent-sdk"
import { describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Stream } from "effect"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Agents } from "../src/Agents.js"
import { fromSdkMessage, make } from "../src/agents/ClaudeCode.js"
import type { AgentInput } from "../src/domain/Agent.js"

const input: AgentInput = {
  prompt: "Create hello.txt",
  cwd: "/tmp/claude-test",
  model: Option.none(),
  maxTurns: Option.none(),
  maxBudgetUsd: Option.none(),
}
const init = { type: "system", subtype: "init", session_id: "session-test" }
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done",
  total_cost_usd: 0.12,
  num_turns: 2,
}
const failed = { ...success, subtype: "error_max_turns", is_error: true, result: undefined }

type SdkInput = Parameters<typeof query>[0]
const fakeQuery = (run: (params: SdkInput) => AsyncIterable<unknown> & { close(): void }): typeof query =>
  new Proxy(query, {
    apply: (_target, _receiver, args: ReadonlyArray<SdkInput>) => {
      const params = args[0]
      assert.ok(params)
      return run(params)
    },
  })
const messages = (values: ReadonlyArray<unknown>) =>
  Object.assign(
    (async function*() {
      yield* values
    })(),
    { close() {} },
  )
const collect = (values: ReadonlyArray<unknown>, task = input) =>
  Effect.scoped(Stream.runCollect(make({ query: fakeQuery(() => messages(values)) }).run(task)))
const fixture = (name: string): ReadonlyArray<unknown> =>
  readFileSync(new URL(`./fixtures/claude/${name}.jsonl`, import.meta.url), "utf8")
    .trim().split("\n").map((line): unknown => JSON.parse(line))

describe("Claude Code adapter", () => {
  it.effect("drops an unmapped type and continues", () =>
    Effect.gen(function*() {
      const events = yield* collect([init, { type: "stream_event" }, success])
      assert.deepStrictEqual(events.map((event) => event._tag), ["Started", "Completed"])
    }))

  it.effect("fails a malformed result with AgentProtocolError and the raw JSON", () =>
    Effect.gen(function*() {
      const malformed = { type: "result", subtype: "success", is_error: false }
      const error = yield* Effect.flip(collect([init, malformed]))
      assert.strictEqual(error._tag, "AgentProtocolError")
      if (error._tag === "AgentProtocolError") {
        assert.strictEqual(error.line, JSON.stringify(malformed))
        assert.ok(error.issue.length > 0)
      }
    }))

  it.effect("maps error results to Failed with subtype or result text", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual((yield* collect([init, failed])).at(-1), {
        _tag: "Failed",
        reason: "error_max_turns",
      })
      assert.deepStrictEqual((yield* collect([init, { ...success, is_error: true, result: "API failed" }])).at(-1), {
        _tag: "Failed",
        reason: "API failed",
      })
    }))

  it.effect("fails an unterminated iterable with AgentCrashed and the last emitted event", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(collect([
        init,
        { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
        { type: "stream_event" },
      ]))
      assert.strictEqual(error._tag, "AgentCrashed")
      if (error._tag === "AgentCrashed") {
        assert.strictEqual(error.exitCode, -1)
        assert.deepStrictEqual(error.lastEvent, Option.some({ _tag: "Text", text: "working" }))
      }
    }))

  it.effect("maps system init to Started with its session id", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual((yield* collect([init, success]))[0], {
        _tag: "Started",
        sessionId: "session-test",
      })
    }))

  it.effect("maps assistant text and tool_use blocks in order", () =>
    Effect.gen(function*() {
      const events = yield* collect([init, {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Writing" },
            { type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "hello.txt", content: "hello" } },
          ],
        },
      }, success])
      assert.deepStrictEqual(events.slice(1, -1), [
        { _tag: "Text", text: "Writing" },
        { _tag: "ToolCall", id: "tool-1", name: "Write", input: { file_path: "hello.txt", content: "hello" } },
      ])
    }))

  it.effect("maps assistant usage to Usage", () =>
    Effect.gen(function*() {
      const events = yield* collect([init, {
        type: "assistant",
        message: { content: [], usage: { input_tokens: 12, output_tokens: 34 } },
      }, success])
      assert.deepStrictEqual(events[1], { _tag: "Usage", inputTokens: 12, outputTokens: 34 })
    }))

  it.effect("maps user tool results with the matching id and error flag", () =>
    Effect.gen(function*() {
      const events = yield* collect([init, {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "denied" }] },
        tool_use_result: { error: "denied" },
      }, success])
      assert.deepStrictEqual(events[1], { _tag: "ToolResult", id: "tool-1", isError: true, summary: "denied" })
    }))

  it.effect("maps successful results with text, cost and turns", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual((yield* collect([init, success])).at(-1), {
        _tag: "Completed",
        result: "Done",
        costUsd: 0.12,
        turns: 2,
      })
    }))

  it.effect("aborts then closes the query when the consuming fiber is interrupted", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const calls: Array<string> = []
      let controller: AbortController | undefined
      const adapter = make({
        query: fakeQuery((params) => {
          controller = params.options?.abortController
          assert.ok(controller)
          controller.signal.addEventListener("abort", () => calls.push("abort"))
          let first = true
          return {
            close: () => calls.push("close"),
            [Symbol.asyncIterator]: () => ({
              next: () => {
                if (first) {
                  first = false
                  return Promise.resolve({ done: false, value: init })
                }
                return new Promise<IteratorResult<unknown>>((resolve) => {
                  controller?.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))
                })
              },
            }),
          }
        }),
      })
      const fiber = yield* Effect.forkChild(Effect.scoped(
        adapter.run(input).pipe(
          Stream.runForEach(() => Deferred.succeed(started, undefined)),
        ),
      ))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(controller?.signal.aborted, true)
      assert.deepStrictEqual(calls, ["abort", "close"])
    }))

  it.effect("passes B6 options and omits absent limits", () =>
    Effect.gen(function*() {
      const options: Array<SdkInput["options"]> = []
      const adapter = make({
        query: fakeQuery((params) => {
          assert.strictEqual(params.prompt, input.prompt)
          options.push(params.options)
          return messages([init, success])
        }),
      })
      yield* Effect.scoped(Stream.runDrain(adapter.run(input)))
      yield* Effect.scoped(Stream.runDrain(adapter.run({
        ...input,
        model: Option.some("test-model"),
        maxTurns: Option.some(40),
        maxBudgetUsd: Option.some(2),
      })))
      const first = options[0]
      const second = options[1]
      assert.ok(first)
      assert.ok(second)
      assert.deepStrictEqual(Object.keys(first).sort(), [
        "abortController",
        "allowedTools",
        "cwd",
        "disallowedTools",
        "permissionMode",
        "settingSources",
      ])
      assert.strictEqual(first.cwd, input.cwd)
      assert.strictEqual(first.permissionMode, "dontAsk")
      assert.deepStrictEqual(first.settingSources, [])
      assert.deepStrictEqual(first.allowedTools, ["Read", "Edit", "Write", "Glob", "Grep", "Bash"])
      assert.deepStrictEqual(first.disallowedTools, [
        "Bash(git worktree *)",
        "Bash(git checkout *)",
        "Bash(git switch *)",
        "Bash(git push *)",
        "AskUserQuestion",
      ])
      assert.strictEqual(second.maxTurns, 40)
      assert.strictEqual(second.maxBudgetUsd, 2)
      assert.strictEqual(second.model, "test-model")
      assert.ok(first.abortController instanceof AbortController)
      assert.notStrictEqual(first.abortController, second.abortController)
    }))

  it.effect("types a throw from query as AgentSpawnError", () =>
    Effect.gen(function*() {
      const cause = new Error("spawn failed")
      const adapter = make({
        query: fakeQuery(() => {
          throw cause
        }),
      })
      const error = yield* Effect.flip(Effect.scoped(Stream.runCollect(adapter.run(input))))
      assert.strictEqual(error._tag, "AgentSpawnError")
      if (error._tag === "AgentSpawnError") assert.strictEqual(error.cause, cause)
    }))

  it.effect("replays the recorded success with Started, ToolCall and exactly one Completed with cost", () =>
    Effect.gen(function*() {
      const events = yield* collect(fixture("success"))
      assert.strictEqual(events[0]?._tag, "Started")
      assert.ok(events.some((event) => event._tag === "ToolCall"))
      assert.strictEqual(events.filter((event) => event._tag === "Completed").length, 1)
      const completed = events.at(-1)
      assert.strictEqual(completed?._tag, "Completed")
      if (completed?._tag === "Completed") assert.strictEqual(typeof completed.costUsd, "number")
    }))

  it.effect("replays the recorded failure with exactly one Failed at the end", () =>
    Effect.gen(function*() {
      const events = yield* collect(fixture("failed"))
      assert.strictEqual(events.at(-1)?._tag, "Failed")
      assert.strictEqual(events.filter((event) => event._tag === "Failed").length, 1)
    }))

  it.effect("types a rejected next as AgentCrashed with the last emitted event", () =>
    Effect.gen(function*() {
      let first = true
      const adapter = make({
        query: fakeQuery(() => ({
          close() {},
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (first) {
                first = false
                return Promise.resolve({ done: false, value: init })
              }
              return Promise.reject(new Error("next failed"))
            },
          }),
        })),
      })
      const error = yield* Effect.flip(Effect.scoped(Stream.runCollect(adapter.run(input))))
      assert.strictEqual(error._tag, "AgentCrashed")
      if (error._tag === "AgentCrashed") {
        assert.deepStrictEqual(error.lastEvent, Option.some({ _tag: "Started", sessionId: "session-test" }))
      }
    }))

  it.effect("stops after the first terminal event", () =>
    Effect.gen(function*() {
      const events = yield* collect([init, success, failed, { type: "assistant", message: { content: [] } }])
      assert.deepStrictEqual(events.map((event) => event._tag), ["Started", "Completed"])
    }))

  it.effect("drops unknown subtypes and blocks but validates known blocks", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* fromSdkMessage({ type: "system", subtype: "status" }), [])
      assert.deepStrictEqual(
        yield* fromSdkMessage({ type: "assistant", message: { content: [{ type: "thinking" }] } }),
        [],
      )
      const error = yield* Effect.flip(fromSdkMessage({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tool-1" }] },
      }))
      assert.strictEqual(error._tag, "AgentProtocolError")
    }))

  it.effect("maps api_retry notifications without implementing retries", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* fromSdkMessage({ type: "system", subtype: "api_retry", attempt: 2, error: "rate_limit" }),
        [
          { _tag: "Retry", attempt: 2, reason: "rate_limit" },
        ],
      )
    }))

  it.effect("reports no last event when an empty iterable crashes", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(collect([]))
      assert.strictEqual(error._tag, "AgentCrashed")
      if (error._tag === "AgentCrashed") assert.deepStrictEqual(error.lastEvent, Option.none())
    }))

  it.effect("registers Claude capabilities and leaves Pi unavailable", () =>
    Effect.gen(function*() {
      const agents = yield* Agents
      assert.ok(Option.isNone(agents.get("pi")))
      const adapter = Option.getOrThrow(agents.get("claude-code"))
      assert.strictEqual(adapter.id, "claude-code")
      assert.deepStrictEqual(adapter.capabilities, {
        maxTurns: true,
        maxBudgetUsd: true,
        model: true,
        costReporting: true,
      })
    }).pipe(Effect.provide(Agents.layer)))
})
