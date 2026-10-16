import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "vitest"

const python = process.env.AGENTRUN_TERMINAL_PYTHON ?? "python3"
// The Python driver fails a run that is silent for `stallSeconds` or longer than `runSeconds`.
// These outer limits only stop a driver that is itself stuck.
const deadlines = JSON.parse(readFileSync(new URL("./terminal-deadlines.json", import.meta.url), "utf8")) as {
  stallSeconds: number
  runSeconds: number
  cleanupSeconds: number
}
const cleanupTimeoutMs = (deadlines.cleanupSeconds + deadlines.stallSeconds) * 1000
const demoTimeoutMs = (scenario: string) =>
  ((scenario === "resume" ? 2 : 1) * deadlines.runSeconds + deadlines.stallSeconds) * 1000 + cleanupTimeoutMs
const fixture = fileURLToPath(new URL("./terminal_fixture.py", import.meta.url))
const demo = fileURLToPath(new URL("./terminal-demo.py", import.meta.url))
// Async so that the PTY tests can run at the same time; each one mostly waits for real processes.
const runPython = (args: ReadonlyArray<string>, timeoutMs: number, env: NodeJS.ProcessEnv = process.env) =>
  new Promise<{ status: number | null; message: string }>((resolve) => {
    const child = spawn(python, args, { env, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    let timedOut = false
    child.stderr.setEncoding("utf8").on("data", (part: string) => (stderr += part))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.on("error", (error) => stderr += String(error))
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({ status, message: timedOut ? `${args[1]} exceeded ${timeoutMs} ms\n${stderr}` : stderr })
    })
  })
if (process.env.AGENTRUN_TERMINAL_PYTHON !== undefined) {
  try {
    if (!isAbsolute(python) || !statSync(python).isFile()) throw new Error("Expected an absolute file")
    accessSync(python, constants.X_OK)
  } catch (cause) {
    throw new Error("AGENTRUN_TERMINAL_PYTHON must name an absolute executable file", { cause })
  }
}

for (const scenario of ["success", "failed", "interrupted", "resize", "resume", "json", "pipe"]) {
  const harnessTimeoutMs = demoTimeoutMs(scenario)
  test.concurrent(`real PTY: ${scenario} preserves output and exit semantics`, async ({ expect, onTestFinished }) => {
    const root = mkdtempSync(join(process.env.AGENTRUN_TEST_EVIDENCE ?? tmpdir(), `terminal-${scenario}-`))
    const nonce = randomUUID().replaceAll("-", "")
    onTestFinished(async () => {
      const cleanup = await runPython([fixture, "close", root, nonce], cleanupTimeoutMs)
      expect(cleanup.status, cleanup.message).toBe(0)
    }, cleanupTimeoutMs + 5000)
    const result = await runPython([demo, scenario, root, process.execPath], harnessTimeoutMs, {
      ...process.env,
      AGENTRUN_TERMINAL_NONCE: nonce,
    })
    expect(result.status, result.message).toBe(0)
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
      if (scenario === "resize") {
        expect(readFileSync(join(root, "running.ansi"), "utf8")).toContain(
          "task0 [running] Task 0 界 👩‍💻 long title for narrow terminals",
        )
        const finalLines = output.split("\x1b[?1049l")[1]?.replaceAll("\r", "").split("\n")
        expect(finalLines?.slice(0, 2)).toEqual([
          "agentrun: finished | 3/3 succee",
          "task0 [succeeded] Task 0 界 ",
        ])
      }
    }
  }, harnessTimeoutMs + 5000)
}

for (const scenario of ["retry", "timeout"]) {
  const harnessTimeoutMs = demoTimeoutMs(scenario)
  test.concurrent(
    `real PTY: ${scenario} renders runner retries and timeout failures`,
    async ({ expect, onTestFinished }) => {
      const root = mkdtempSync(join(process.env.AGENTRUN_TEST_EVIDENCE ?? tmpdir(), `terminal-${scenario}-`))
      const nonce = randomUUID().replaceAll("-", "")
      onTestFinished(async () => {
        const cleanup = await runPython([fixture, "close", root, nonce], cleanupTimeoutMs)
        expect(cleanup.status, cleanup.message).toBe(0)
      }, cleanupTimeoutMs + 5000)
      const result = await runPython([demo, scenario, root, process.execPath], harnessTimeoutMs, {
        ...process.env,
        AGENTRUN_TERMINAL_NONCE: nonce,
      })
      expect(result.status, result.message).toBe(0)
      const saved = JSON.parse(readFileSync(join(root, "result.json"), "utf8"))
      const output = readFileSync(join(root, "capture.ansi"), "utf8")
      expect(saved.exitCode).toBe(scenario === "retry" ? 0 : 1)
      expect(output).toContain(scenario === "retry" ? "Runner retry 2" : "AgentTimedOut")
      expect(output).toContain("\x1b[?25h")
      expect(Object.values(saved.savedStatus).map((s) => (s as { _tag: string })._tag)).toEqual(
        Array(3).fill(scenario === "retry" ? "succeeded" : "failed"),
      )
      for (let n = 0; n < 3; n++) {
        const starts = readFileSync(join(root, `starts-task${n}`), "utf8").trim().split("\n")
        expect(starts).toHaveLength(scenario === "retry" ? 3 : 1)
        if (scenario === "timeout") {
          expect(saved.savedStatus[`task${n}`].reason).toMatch(/^AgentTimedOut:/)
        }
      }
      if (scenario === "timeout") expect(output).toContain("alive")
    },
    harnessTimeoutMs + 5000,
  )
}

const processTable = () =>
  spawnSync("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,stat=,command="], { encoding: "utf8" }).stdout
    .split("\n").filter((line) => line.trim() !== "").map((line) => {
      const fields = line.trim().split(/\s+/)
      return {
        pid: Number(fields[0]),
        parent: Number(fields[1]),
        start: fields.slice(2, 7).join(" "),
        zombie: (fields[7] ?? "").startsWith("Z"),
        command: fields.slice(8).join(" "),
      }
    })

test.concurrent(
  "fixture cleanup removes the whole tree after the driver is killed while ps fails",
  async ({ expect, onTestFinished }) => {
    const root = mkdtempSync(join(process.env.AGENTRUN_TEST_EVIDENCE ?? tmpdir(), "terminal-killed-driver-"))
    const nonce = randomUUID().replaceAll("-", "")
    const driver = spawn(python, [demo, "timeout", root, process.execPath], {
      stdio: "ignore",
      env: { ...process.env, AGENTRUN_TERMINAL_NONCE: nonce },
    })
    onTestFinished(async () => {
      driver.kill("SIGKILL")
      const cleanup = await runPython([fixture, "close", root, nonce], cleanupTimeoutMs)
      expect(cleanup.status, cleanup.message).toBe(0)
    }, cleanupTimeoutMs + 5000)

    const deadline = Date.now() + deadlines.runSeconds * 1000
    while (!existsSync(join(root, "starts-task2"))) {
      if (driver.exitCode !== null || Date.now() > deadline) throw new Error("The workers did not start")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const tree = new Map<number, ReturnType<typeof processTable>[number]>()
    const collect = () => {
      const rows = processTable()
      for (const row of rows) {
        if (row.command.includes(nonce) || row.command.includes(root) || tree.has(row.parent)) tree.set(row.pid, row)
      }
    }
    collect()
    driver.kill("SIGKILL")
    await new Promise((resolve) => driver.once("exit", resolve))
    collect()
    expect(tree.size).toBeGreaterThan(3)

    // `ps` fails on every second call, as it does when the host is overloaded.
    const shim = mkdtempSync(join(tmpdir(), "flaky-ps-"))
    writeFileSync(
      join(shim, "ps"),
      [
        "#!/bin/bash",
        `n=$(( $(cat ${shim}/count 2>/dev/null || echo 0) + 1 ))`,
        `echo $n > ${shim}/count`,
        "if [ $((n % 2)) -eq 0 ]; then echo 'ps: simulated failure' >&2; exit 1; fi",
        "exec /bin/ps \"$@\"",
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    const cleanup = await runPython([fixture, "close", root, nonce], cleanupTimeoutMs, {
      ...process.env,
      PATH: `${shim}:${process.env.PATH}`,
    })
    const survivors = processTable().filter((row) => {
      const before = tree.get(row.pid)
      return before !== undefined && before.start === row.start && !row.zombie
    })
    expect(survivors.map((row) => `${row.pid} ${row.command}`)).toEqual([])
    expect(cleanup.status, cleanup.message).toBe(0)
  },
  (deadlines.runSeconds + deadlines.stallSeconds) * 1000 + 2 * cleanupTimeoutMs,
)
