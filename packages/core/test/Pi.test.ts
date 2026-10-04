import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent"
import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agents } from "../src/Agents.js"
import { make } from "../src/agents/Pi.js"
import type { Session } from "../src/agents/Pi.js"
import type { AgentInput } from "../src/domain/Agent.js"
import type { AgentEvent } from "../src/domain/AgentEvent.js"
import { TaskFile } from "../src/TaskFile.js"

const input: AgentInput = {
  prompt: "Reply done",
  cwd: "/unused",
  model: Option.none(),
  maxTurns: Option.none(),
  maxBudgetUsd: Option.none(),
}
const assistant = (text = "done", stopReason = "stop") => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text }],
    usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.02 } },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "model failed" } : {}),
  },
})
const settled = { type: "agent_settled" }

class FakeSession implements Session {
  readonly sessionId = "session-test"
  listener: ((event: unknown) => void) | undefined
  readonly cleanup: Array<string> = []
  resolvePrompt: () => void = () => {}
  readonly started: Promise<void>
  private start: () => void = () => {}
  abortWait: Promise<void> = Promise.resolve()
  constructor(readonly events: ReadonlyArray<unknown> = [], readonly pending = false, readonly reject = false) {
    this.started = new Promise((resolve) => {
      this.start = resolve
    })
  }
  subscribe(listener: (event: unknown) => void) {
    this.listener = listener
    return () => {
      this.cleanup.push("unsubscribe")
      this.listener = undefined
    }
  }
  emit(event: unknown) {
    this.listener?.(event)
  }
  prompt(_text: string) {
    this.start()
    for (const event of this.events) this.emit(event)
    if (this.reject) return Promise.reject(new Error("prompt failed"))
    return this.pending
      ? new Promise<void>((resolve) => {
        this.resolvePrompt = resolve
      })
      : Promise.resolve()
  }
  abort() {
    this.cleanup.push("abort")
    this.emit(settled)
    return this.abortWait.then(() => {
      this.cleanup.push("aborted")
      this.resolvePrompt()
    })
  }
  dispose() {
    this.cleanup.push("dispose")
  }
}
const adapterFor = (session: Session) => make({ createAgentSession: () => Promise.resolve({ session }) })
const collect = (events: ReadonlyArray<unknown>, overrides: Partial<AgentInput> = {}) =>
  Effect.scoped(Stream.runCollect(adapterFor(new FakeSession(events)).run({ ...input, ...overrides })))

const expectError = Effect.fnUntraced(function*(events: ReadonlyArray<unknown>, tag: string) {
  const error = yield* Effect.flip(collect(events))
  assert.strictEqual(error._tag, tag)
})

describe("Pi", () => {
  it.effect("starts once before SDK events and closes at the first settlement", () =>
    Effect.gen(function*() {
      const events = yield* collect([
        { type: "agent_start" },
        { type: "agent_start" },
        assistant(),
        { type: "agent_end" },
        settled,
        settled,
        assistant("late"),
      ])
      assert.deepStrictEqual(events, [
        { _tag: "Started", sessionId: "session-test" },
        { _tag: "Text", text: "done" },
        { _tag: "Usage", inputTokens: 10, outputTokens: 3, costUsd: 0.02 },
        { _tag: "Completed", result: "done", costUsd: 0.02, turns: 1 },
      ])
      const recorded: ReadonlyArray<unknown> = readFileSync(
        new URL("./fixtures/pi/success.jsonl", import.meta.url),
        "utf8",
      )
        .trim().split("\n").map((line): unknown => JSON.parse(line))
      const replay = yield* collect([...recorded, settled, assistant("late")])
      assert.deepStrictEqual(replay, [
        { _tag: "Started", sessionId: "session-test" },
        { _tag: "Usage", inputTokens: 1746, outputTokens: 24, costUsd: 0.01866 },
        { _tag: "ToolCall", id: "tool-test", name: "write", input: { path: "result.txt", content: "pi-ok" } },
        { _tag: "ToolResult", id: "tool-test", isError: false, summary: "Successfully wrote 5 bytes to result.txt" },
        { _tag: "Text", text: "done" },
        { _tag: "Usage", inputTokens: 1786, outputTokens: 5, costUsd: 0.01811 },
        { _tag: "Completed", result: "done", costUsd: 0.03677, turns: 2 },
      ])
    }))

  it.effect("counts assistant responses once and ignores deltas, user and tool usage", () =>
    Effect.gen(function*() {
      const events = yield* collect([
        { type: "message_update", usage: { input: 99 } },
        { type: "message_end", message: { role: "user", content: "user", usage: { input: 99 } } },
        { type: "message_end", message: { role: "toolResult", content: [], usage: { input: 99 } } },
        assistant("first"),
        assistant("second"),
        settled,
      ])
      assert.deepStrictEqual(events.filter((event) => event._tag === "Usage"), [
        { _tag: "Usage", inputTokens: 10, outputTokens: 3, costUsd: 0.02 },
        { _tag: "Usage", inputTokens: 10, outputTokens: 3, costUsd: 0.02 },
      ])
      assert.deepStrictEqual(events.at(-1), { _tag: "Completed", result: "second", costUsd: 0.04, turns: 2 })
    }))

  it.effect("correlates tool IDs and preserves arguments, summary and errors", () =>
    Effect.gen(function*() {
      const events = yield* collect([
        { type: "tool_execution_start", toolCallId: "tool-test", toolName: "read", args: { path: "file.txt" } },
        {
          type: "tool_execution_end",
          toolCallId: "tool-test",
          isError: true,
          result: { content: [{ type: "text", text: "missing" }, { type: "image", data: "synthetic" }] },
        },
        settled,
      ])
      assert.deepStrictEqual(events.slice(1, 3), [
        { _tag: "ToolCall", id: "tool-test", name: "read", input: { path: "file.txt" } },
        { _tag: "ToolResult", id: "tool-test", isError: true, summary: "missing" },
      ])
    }))

  it.effect("waits through agent_end and clears failure after successful automatic retry", () =>
    Effect.gen(function*() {
      const events = yield* collect([
        assistant("", "error"),
        { type: "agent_end", willRetry: true },
        { type: "auto_retry_start", attempt: 1, errorMessage: "model failed" },
        assistant("recovered"),
        { type: "auto_retry_end", success: true, attempt: 1 },
        settled,
      ])
      assert.deepStrictEqual(events.filter((event) => event._tag === "Retry"), [
        { _tag: "Retry", attempt: 1, reason: "model failed" },
      ])
      assert.strictEqual(events.at(-1)?._tag, "Completed")
      assert.strictEqual(events.filter((event) => event._tag === "Failed").length, 0)
    }))

  for (
    const [name, records, reason] of [
      ["response error", [assistant("", "error")], "model failed"],
      ["aborted response", [assistant("", "aborted")], "aborted"],
      [
        "retry exhaustion",
        [{ type: "auto_retry_end", success: false, attempt: 2, finalError: "exhausted" }],
        "exhausted",
      ],
      ["SDK error", [{ type: "error", error: "sdk failed" }], "sdk failed"],
    ] as const
  ) {
    it.effect(`fails ${name} only at settlement`, () =>
      Effect.gen(function*() {
        const events = yield* collect([...records, { type: "agent_end" }, settled])
        assert.deepStrictEqual(events.at(-1), { _tag: "Failed", reason })
        assert.strictEqual(events.filter((event) => event._tag === "Failed").length, 1)
      }))
  }

  it.effect("returns AgentSpawnError for rejected or synchronous session creation", () =>
    Effect.gen(function*() {
      for (
        const createAgentSession of [
          () => Promise.reject(new Error("create failed")),
          () => {
            throw new Error("create threw")
          },
        ]
      ) {
        const error = yield* Effect.flip(Effect.scoped(Stream.runCollect(make({ createAgentSession }).run(input))))
        assert.strictEqual(error._tag, "AgentSpawnError")
      }
    }))

  it.effect("returns AgentCrashed for a rejected prompt and releases the session", () =>
    Effect.gen(function*() {
      const session = new FakeSession([], false, true)
      const error = yield* Effect.flip(Effect.scoped(Stream.runCollect(adapterFor(session).run(input))))
      assert.strictEqual(error._tag, "AgentCrashed")
      if (error._tag === "AgentCrashed") {
        assert.deepStrictEqual(error.lastEvent, Option.some({ _tag: "Started", sessionId: "session-test" }))
      }
      assert.deepStrictEqual(session.cleanup, ["unsubscribe", "abort", "aborted", "dispose"])
    }))

  it.effect("requires settlement even when prompt returns or agent_end arrives", () =>
    Effect.gen(function*() {
      yield* expectError([], "AgentCrashed")
      yield* expectError([assistant(), { type: "agent_end" }], "AgentCrashed")
    }))

  for (
    const event of [
      { type: "message_end" },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text" }],
          usage: { input: 1, output: 2, cost: { total: 0 } },
          stopReason: "stop",
        },
      },
      { type: "tool_execution_start", toolCallId: "tool-test", toolName: "read" },
      { type: "tool_execution_end", toolCallId: "tool-test", isError: "false", result: {} },
      { type: "auto_retry_start", attempt: "1", errorMessage: "retry" },
      { type: "auto_retry_end", success: "false" },
      { type: "error" },
    ]
  ) {
    it.effect(`types malformed ${event.type} as AgentProtocolError`, () =>
      expectError([event, settled], "AgentProtocolError"))
  }

  it.effect("drops irrelevant known and unknown events without ending", () =>
    Effect.gen(function*() {
      const events = yield* collect([{ type: "turn_start" }, { type: "future_event", value: 1 }, assistant(), settled])
      assert.strictEqual(events.at(-1)?._tag, "Completed")
    }))

  it.live("cancels only its session, waits for abort cleanup and emits no success", () =>
    Effect.gen(function*() {
      const first = new FakeSession([], true)
      const second = new FakeSession([], true)
      let finishAbort: () => void = () => {}
      first.abortWait = new Promise((resolve) => {
        finishAbort = resolve
      })
      const observed: Array<AgentEvent> = []
      const firstFiber = yield* Effect.forkChild(Effect.scoped(
        adapterFor(first).run(input).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              observed.push(event)
            })
          ),
        ),
      ))
      const secondFiber = yield* Effect.forkChild(Effect.scoped(Stream.runCollect(adapterFor(second).run(input))))
      yield* Effect.promise(() => Promise.all([first.started, second.started]))
      const interruption = yield* Effect.forkChild(Fiber.interrupt(firstFiber))
      yield* Effect.yieldNow
      assert.strictEqual(first.cleanup.includes("dispose"), false)
      assert.deepStrictEqual(second.cleanup, [])
      finishAbort()
      yield* Fiber.join(interruption)
      assert.ok(Exit.hasInterrupts(yield* Fiber.await(firstFiber)))
      assert.deepStrictEqual(first.cleanup, ["unsubscribe", "abort", "aborted", "dispose"])
      assert.strictEqual(observed.some((event) => event._tag === "Completed"), false)
      second.emit(assistant("second"))
      second.emit(settled)
      second.resolvePrompt()
      assert.strictEqual((yield* Fiber.join(secondFiber)).at(-1)?._tag, "Completed")
    }))

  it.effect("uses in-memory settings/history and disables project resource discovery", () =>
    Effect.gen(function*() {
      const cwd = mkdtempSync(join(tmpdir(), "agentrun-pi-options-"))
      try {
        mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true })
        writeFileSync(join(cwd, ".pi", "settings.json"), "{\"defaultProvider\":\"invalid\"}")
        writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_SENTINEL")
        writeFileSync(join(cwd, ".pi", "SYSTEM.md"), "PROJECT_SYSTEM_SENTINEL")
        writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT_APPEND_SENTINEL")
        writeFileSync(join(cwd, ".pi", "extensions", "bad.ts"), "throw new Error(\"project extension loaded\")")
        const adapter = make({
          createAgentSession: (options: CreateAgentSessionOptions) => {
            assert.strictEqual(options.cwd, cwd)
            assert.deepStrictEqual(options.tools, ["read", "bash", "edit", "write", "grep", "find", "ls"])
            assert.strictEqual(options.settingsManager?.getDefaultProvider(), undefined)
            assert.strictEqual(options.sessionManager?.getSessionFile(), undefined)
            assert.deepStrictEqual(options.resourceLoader?.getAgentsFiles().agentsFiles, [])
            assert.strictEqual(options.resourceLoader?.getSystemPrompt(), undefined)
            assert.deepStrictEqual(options.resourceLoader?.getAppendSystemPrompt(), [])
            assert.deepStrictEqual(options.resourceLoader?.getSkills().skills, [])
            assert.deepStrictEqual(options.resourceLoader?.getPrompts().prompts, [])
            assert.deepStrictEqual(options.resourceLoader?.getThemes().themes, [])
            assert.deepStrictEqual(options.resourceLoader?.getExtensions().extensions, [])
            return Promise.resolve({ session: new FakeSession([assistant(), settled]) })
          },
        })
        yield* Effect.scoped(Stream.runCollect(adapter.run({ ...input, cwd })))
      } finally {
        rmSync(cwd, { recursive: true })
      }
    }))

  it.live("resolves a requested model through the installed SDK and rejects invalid models", () =>
    Effect.gen(function*() {
      let selected: CreateAgentSessionOptions["model"]
      const adapter = make({
        createAgentSession: (options) => {
          selected = options.model
          return Promise.resolve({ session: new FakeSession([assistant(), settled]) })
        },
      })
      yield* Effect.scoped(Stream.runCollect(adapter.run({ ...input, model: Option.some("openai/gpt-6-astra") })))
      assert.strictEqual(selected?.provider, "openai")
      assert.strictEqual(selected?.id, "gpt-6-astra")
      for (const model of ["invalid", "openai/no-such-model"]) {
        const error = yield* Effect.flip(
          Effect.scoped(Stream.runCollect(adapter.run({ ...input, model: Option.some(model) }))),
        )
        assert.strictEqual(error._tag, "AgentSpawnError")
        if (error._tag === "AgentSpawnError") assert.match(String(error.cause), /model/i)
      }
    }))

  it.effect("registers Pi capabilities and rejects unsupported limits at parse and direct invocation", () =>
    Effect.gen(function*() {
      const agents = yield* Agents
      const pi = Option.getOrThrow(agents.get("pi"))
      const claude = Option.getOrThrow(agents.get("claude-code"))
      assert.deepStrictEqual(pi.capabilities, {
        maxTurns: false,
        maxBudgetUsd: false,
        model: true,
        costReporting: true,
      })
      for (const option of ["maxTurns", "maxBudgetUsd"] as const) {
        const parseError:
          | import("../src/domain/Errors.js").TaskFileError
          | import("../src/domain/Errors.js").UnsupportedOption = yield* Effect.flip(TaskFile.parse({
            path: "TASKS.md",
            content: `---\nagent: pi\n${option}: 1\n---\n## test: Test\nReply done\n`,
            capabilities: { pi: pi.capabilities, "claude-code": claude.capabilities },
          }))
        assert.strictEqual(parseError._tag, "UnsupportedOption")
        let calls = 0
        const adapter = make({
          createAgentSession: () => {
            calls++
            return Promise.resolve({ session: new FakeSession([settled]) })
          },
        })
        const error = yield* Effect.flip(
          Effect.scoped(Stream.runCollect(adapter.run({ ...input, [option]: Option.some(1) }))),
        )
        assert.strictEqual(error._tag, "AgentSpawnError")
        assert.strictEqual(calls, 0)
      }
    }).pipe(Effect.provide(Agents.layer)))
})
