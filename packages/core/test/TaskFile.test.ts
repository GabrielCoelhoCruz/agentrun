import { describe, it } from "@effect/vitest"
import { Duration, Effect, Option } from "effect"
import assert from "node:assert/strict"
import { TaskFile } from "../src/TaskFile.js"

const capabilities = {
  "claude-code": { maxTurns: true, maxBudgetUsd: true, model: true, costReporting: true },
  pi: { maxTurns: true, maxBudgetUsd: false, model: true, costReporting: true },
}

describe("TaskFile.parse", () => {
  it.effect.each([
    {
      name: "heading without id",
      content: "## Fix login\nFix it.",
      line: 1,
      message: "expected heading ## <id>: <title>",
    },
    {
      name: "id outside kebab-case",
      content: "## Fix_Login: x\nFix it.",
      line: 1,
      message: "task id must be kebab-case",
    },
    {
      name: "duplicate id at the second heading",
      content: "## fix-login: First\nFirst prompt.\n\n## fix-login: Second\nSecond prompt.",
      line: 4,
      message: "duplicate task id \"fix-login\"",
    },
    {
      name: "empty body",
      content: "## fix-login: Fix login",
      line: 1,
      message: "Expected a value with a length of at least 1",
    },
    {
      name: "whitespace body",
      content: "## fix-login: Fix login\n \t\n  ",
      line: 1,
      message: "Expected a value with a length of at least 1",
    },
    {
      name: "unknown frontmatter key",
      content: "---\nconcurency: 3\n---\n## fix-login: Fix login\nFix it.",
      line: 2,
      message: "Expected no excess property\n  at [\"concurency\"]",
    },
    {
      name: "unknown override key",
      content: "## fix-login: Fix login\nconcurency: 3\n\nFix it.",
      line: 2,
      message: "Expected no excess property\n  at [\"concurency\"]",
    },
    {
      name: "base override",
      content: "## fix-login: Fix login\nbase: main\n\nFix it.",
      line: 2,
      message: "Expected no excess property\n  at [\"base\"]",
    },
    {
      name: "concurrency override",
      content: "## fix-login: Fix login\nconcurrency: 3\n\nFix it.",
      line: 2,
      message: "Expected no excess property\n  at [\"concurrency\"]",
    },
    {
      name: "setup override",
      content: "## fix-login: Fix login\nsetup: pnpm install\n\nFix it.",
      line: 2,
      message: "Expected no excess property\n  at [\"setup\"]",
    },
    {
      name: "unknown agent",
      content: "## fix-login: Fix login\nagent: other\n\nFix it.",
      line: 2,
      message: "Expected \"claude-code\" | \"pi\"\n  at [\"agent\"]",
    },
    {
      name: "invalid duration",
      content: "---\nstallTimeout: soon\n---\n## fix-login: Fix login\nFix it.",
      line: 2,
      message: "Expected a valid Duration string\n  at [\"stallTimeout\"]",
    },
    {
      name: "frontmatter without tasks",
      content: "---\nbase: main\n---\n",
      line: 1,
      message: "expected at least one task",
    },
    {
      name: "malformed YAML",
      content: "---\nagent: [unclosed\n---\n## fix-login: Fix login\nFix it.",
      line: 2,
      message:
        "Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 17:\n\nagent: [unclosed\n                ^\n",
    },
  ])("rejects $name", ({ content, line, message }) =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(TaskFile.parse({ path: "TASKS.md", content, capabilities }))
      assert.deepStrictEqual({ ...error, message: error.message }, {
        _tag: "TaskFileError",
        path: "TASKS.md",
        line,
        message: `TASKS.md:${line}: ${message}`,
      })
    }))

  it.effect.each(["maxBudgetUsd", "maxTurns", "model"])("rejects unsupported %s", (option) =>
    Effect.gen(function*() {
      const content = [
        "---",
        "base: main",
        "concurrency: 3",
        "agent: claude-code",
        "setup: pnpm install",
        "stallTimeout: 5 minutes",
        "maxDuration: 60 minutes",
        "---",
        "",
        "",
        "",
        "## fix-login: Fix login",
        "agent: pi",
        `${option}: ${option === "model" ? "test-model" : 40}`,
        "",
        "Fix it.",
      ].join("\n")
      const error = yield* Effect.flip(TaskFile.parse({
        path: "TASKS.md",
        content,
        capabilities: { ...capabilities, pi: { ...capabilities.pi, [option]: false } },
      }))
      assert.deepStrictEqual({ ...error, message: error.message }, {
        _tag: "UnsupportedOption",
        path: "TASKS.md",
        line: 14,
        taskId: "fix-login",
        agent: "pi",
        option,
        message: `TASKS.md:14: task "fix-login": ${option} is not supported by agent "pi"`,
      })
    }))

  it.effect("decodes the exact B2 example", () =>
    Effect.gen(function*() {
      const content = `---
base: main
concurrency: 3
agent: claude-code
setup: pnpm install
stallTimeout: 5 minutes
maxDuration: 60 minutes
---

## fix-login: Fix the login timeout
agent: pi
maxTurns: 40

The POST /login endpoint returns 504 when Redis is slow.
Add a 2s timeout to the client and a test.

## add-healthcheck: /health endpoint

Create GET /health that returns 200 and the package version.`
      const file = yield* TaskFile.parse({ path: "TASKS.md", content, capabilities })
      assert.strictEqual(file.base, "main")
      assert.strictEqual(file.concurrency, 3)
      assert.deepStrictEqual(file.setup, Option.some("pnpm install"))
      assert.deepStrictEqual(
        file.tasks.map((task) => ({
          ...task,
          stallTimeout: Duration.toMillis(task.stallTimeout),
          maxDuration: Duration.toMillis(task.maxDuration),
        })),
        [
          {
            id: "fix-login",
            title: "Fix the login timeout",
            prompt:
              "The POST /login endpoint returns 504 when Redis is slow.\nAdd a 2s timeout to the client and a test.",
            agent: "pi",
            maxTurns: 40,
            stallTimeout: 300_000,
            maxDuration: 3_600_000,
          },
          {
            id: "add-healthcheck",
            title: "/health endpoint",
            prompt: "Create GET /health that returns 200 and the package version.",
            agent: "claude-code",
            stallTimeout: 300_000,
            maxDuration: 3_600_000,
          },
        ],
      )
    }))

  it.effect("uses defaults without frontmatter", () =>
    Effect.gen(function*() {
      const file = yield* TaskFile.parse({
        path: "TASKS.md",
        content: "## fix-login: Fix login\n\nFix it.\n",
        capabilities,
      })
      assert.strictEqual(file.base, "HEAD")
      assert.strictEqual(file.concurrency, 2)
      assert.deepStrictEqual(file.setup, Option.none())
      assert.deepStrictEqual(
        file.tasks.map((task) => ({
          ...task,
          stallTimeout: Duration.toMillis(task.stallTimeout),
          maxDuration: Duration.toMillis(task.maxDuration),
        })),
        [{
          id: "fix-login",
          title: "Fix login",
          prompt: "Fix it.",
          agent: "claude-code",
          stallTimeout: 300_000,
          maxDuration: 3_600_000,
        }],
      )
    }))
})
