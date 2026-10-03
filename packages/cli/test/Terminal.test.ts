import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

for (const scenario of ["success", "failed", "interrupted", "resize", "resume", "json", "pipe"]) {
  test(`real PTY: ${scenario} preserves output and exit semantics`, () => {
    const root = mkdtempSync(join(process.env.AGENTRUN_TEST_EVIDENCE ?? tmpdir(), `terminal-${scenario}-`))
    const result = spawnSync("python3", [
      fileURLToPath(new URL("./terminal-demo.py", import.meta.url)),
      scenario,
      root,
      process.execPath,
    ], { encoding: "utf8", timeout: 30000 })
    expect(result.status, result.stderr).toBe(0)
    const saved = JSON.parse(readFileSync(join(root, "result.json"), "utf8"))
    const output = readFileSync(join(root, "capture.ansi"), "utf8")
    expect(saved.exitCode).toBe(scenario === "failed" ? 1 : scenario === "interrupted" ? 130 : 0)
    const statuses = Object.values(saved.savedStatus).map((status) => (status as { _tag: string })._tag)
    expect(statuses).toEqual(
      scenario === "failed"
        ? ["succeeded", "failed", "succeeded"]
        : scenario === "interrupted"
        ? ["interrupted", "interrupted", "interrupted"]
        : ["succeeded", "succeeded", "succeeded"],
    )
    if (scenario === "json" || scenario === "pipe") {
      expect(readFileSync(join(root, "stderr.txt"), "utf8")).toContain("worker warning task2")
    }
    if (scenario === "json") {
      for (const line of output.trim().split("\n")) JSON.parse(line)
      expect(output).not.toContain("\x1b")
    } else if (scenario === "pipe") {
      expect(output).toContain("Task task0: running")
      expect(output).not.toContain("\x1b")
    } else {
      expect(output).toContain("\x1b[?25l")
      expect(output).toContain("\x1b[?25h")
      expect(output).not.toContain("\x1b]52")
      expect(output).toContain("task0")
      expect(output).toContain("task1")
      expect(output).toContain("task2")
      expect(output).toContain(
        scenario === "interrupted" ? "interrupted" : scenario === "failed" ? "failed" : "succeeded",
      )
      if (scenario === "resume") expect(output).toContain("saved failure")
    }
  }, 35000)
}

for (const scenario of ["retry", "timeout"]) {
  test(`real PTY: ${scenario} renders runner retries and timeout failures`, () => {
    const root = mkdtempSync(join(process.env.AGENTRUN_TEST_EVIDENCE ?? tmpdir(), `terminal-${scenario}-`))
    const result = spawnSync("python3", [
      fileURLToPath(new URL("./terminal-demo.py", import.meta.url)),
      scenario,
      root,
      process.execPath,
    ], { encoding: "utf8", timeout: 30000 })
    expect(result.status, result.stderr).toBe(0)
    const saved = JSON.parse(readFileSync(join(root, "result.json"), "utf8"))
    const output = readFileSync(join(root, "capture.ansi"), "utf8")
    expect(saved.exitCode).toBe(scenario === "retry" ? 0 : 1)
    expect(output).toContain(scenario === "retry" ? "Runner retry 2" : "AgentTimedOut")
    expect(output).toContain("\x1b[?25h")
    expect(Object.values(saved.savedStatus).map((s) => (s as { _tag: string })._tag)).toEqual(
      Array(3).fill(scenario === "retry" ? "succeeded" : "failed"),
    )
  }, 35000)
}
