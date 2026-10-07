import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { stop } from "../src/Processes.js"
import { Store } from "../src/Store.js"

test.each(["exit", "timeout"])("factory cleanup retains native process-table cause (%s)", async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "factory-cleanup-cause-"))
  const token = "c".repeat(32)
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", `agentrun-factory-${token}`], {
    detached: true,
    stdio: "ignore",
  })
  const done = once(child, "close")
  const original = process.env.PATH
  writeFileSync(
    join(directory, "ps"),
    `#!/bin/sh
printf 'Permission denied: /private/fixture TOKEN=private-token\\n' >&2
${mode === "exit" ? "exit 23" : "exec node -e 'setInterval(()=>{},1000)'"}
`,
    { mode: 0o755 },
  )
  try {
    process.env.PATH = `${directory}:${original}`
    const failure = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const store = yield* Store.open(join(directory, "store"), true)
      yield* stop(store, "attempt", {
        pid: child.pid!,
        token,
        generation: 1,
        directory,
        commandHash: "a".repeat(64),
        command: { argv: [process.execPath], cwd: directory },
      }, "Test cleanup")
    }))).then(() => {
      throw new Error("Expected cleanup refusal")
    }, (error: unknown) => error)
    expect(failure).toMatchObject({ code: "process-ownership", exitCode: 1 })
    const message = String(failure)
    expect(message).toContain("\"timeoutMs\":5000")
    expect(message).toContain(mode === "exit" ? "\"code\":23" : "\"signal\":\"SIGTERM\"")
    expect(message).toContain("permission denied")
    expect(message).not.toMatch(/private-token|\/private\/fixture|TOKEN=/)
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
    if (process.env.AGENTRUN_TEST_EVIDENCE) {
      writeFileSync(
        join(process.env.AGENTRUN_TEST_EVIDENCE, `factory-cleanup-${mode}.json`),
        JSON.stringify({ mode, message }),
      )
    }
  } finally {
    process.env.PATH = original
    child.kill("SIGKILL")
    await done
  }
}, 15000)
