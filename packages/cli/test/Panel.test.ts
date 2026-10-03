import { TaskId } from "@agentrun/core"
import type { RunState } from "@agentrun/core"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { makePanel, panelScoped } from "../src/ui/Panel.js"

const state = {
  runId: "demo",
  tasks: ["a", "b", "c"].map((id) => ({ id: TaskId.make(id), title: `Title ${id} 界 👩‍💻` })),
  status: {
    a: { _tag: "succeeded", durationMs: 10 },
    b: { _tag: "failed", attempt: 1, reason: "saved failure" },
    c: { _tag: "pending" },
  },
} as unknown as RunState

test("saved statuses, reasons and three tasks survive narrow rendering", () => {
  const panel = makePanel(state)
  const lines = panel.lines(40, 12)
  expect(lines.join("\n")).toContain("succeeded")
  expect(lines.join("\n")).toContain("saved failure")
  expect(lines.join("\n")).toContain("pending")
  expect(lines.join("\n")).toContain("Title c")
  expect(panel.lines(12, 5)).toHaveLength(4)
})

test("hostile multiline and huge logs stay bounded without changing status", () => {
  const panel = makePanel(state)
  const taskId = TaskId.make("c")
  panel.event({
    _tag: "TaskAgentEvent",
    taskId,
    event: { _tag: "Text", text: "\x1b[2J\x1b]52;c;bad\x07unsafe\r\b\u009b2J\nnext" },
  })
  // eslint-disable-next-line no-control-regex -- Assert that hostile controls are removed.
  expect(panel.logs(taskId).join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  for (let n = 0; n < 1100; n++) {
    panel.event({ _tag: "TaskAgentEvent", taskId, event: { _tag: "Text", text: `line ${n}` } })
  }
  expect(panel.logs(taskId)).toHaveLength(1000)
  expect(panel.logs(taskId)[0]).toBe("line 100")
  panel.event({ _tag: "TaskAgentEvent", taskId, event: { _tag: "Text", text: "x".repeat(100000) } })
  expect(panel.logs(taskId).at(-1)?.length).toBeLessThanOrEqual(4096)
  expect(panel.lines(60, 20).join("\n")).toContain("pending")
})

test("scoped failure restores cursor, drains final status and removes resize listener", async () => {
  let output = ""
  const before = process.stdout.listenerCount("resize")
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const panel = yield* panelScoped(state, (chunk) => {
      output += chunk
    })
    for (let n = 0; n < 200; n++) {
      panel.event({ _tag: "TaskAgentEvent", taskId: TaskId.make("c"), event: { _tag: "Text", text: `burst ${n}` } })
    }
    panel.event({ _tag: "TaskTransition", taskId: TaskId.make("c"), status: { _tag: "interrupted", attempt: 1 } })
    return yield* Effect.fail("expected failure")
  }))).catch(() => {})
  expect(output).toContain("interrupted")
  expect(output).toContain("\x1b[?25l")
  expect(output.endsWith("\x1b[?25h")).toBe(true)
  expect(output.split("\x1b[H").length).toBeLessThan(10)
  expect(process.stdout.listenerCount("resize")).toBe(before)
})
