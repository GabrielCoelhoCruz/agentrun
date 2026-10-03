import { Effect } from "effect"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { stopProcessGroup } from "../src/ProcessGroup.js"

const token = "a".repeat(32)
const start = () =>
  spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", `agentrun-worker-${token}`], {
    detached: true,
    stdio: "ignore",
  })

test("owned cleanup accepts unrelated process-table rows with group zero", async () => {
  const realTable = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], { encoding: "utf8" })
  expect(realTable.status).toBe(0)
  const zeroGroups = realTable.stdout.trim().split("\n").filter((line) => line.trim().split(/\s+/)[2] === "0").length
  console.info(`OS process evidence: ${zeroGroups} actual rows have group zero`)
  const directory = mkdtempSync(join(tmpdir(), "agentrun-ps-"))
  writeFileSync(
    join(directory, "ps"),
    `#!/bin/sh
/bin/ps "$@"
case "$1" in -axo) echo '999999 0 0 S';; esac
`,
    { mode: 0o755 },
  )
  const original = process.env.PATH
  const child = start()
  const done = new Promise((resolve) => child.on("close", resolve))
  try {
    process.env.PATH = `${directory}:${original}`
    await Effect.runPromise(stopProcessGroup(child.pid!, token))
    await done
  } finally {
    process.env.PATH = original
    child.kill("SIGKILL")
    await done
  }
})

test("a live group omitted from the process table refuses cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentrun-ps-hidden-"))
  writeFileSync(
    join(directory, "ps"),
    `#!/bin/sh
if [ "$1" = -axo ]; then echo '999999 0 999999 S'; else /bin/ps "$@"; fi
`,
    { mode: 0o755 },
  )
  const original = process.env.PATH
  const child = start()
  const done = new Promise((resolve) => child.on("close", resolve))
  try {
    process.env.PATH = `${directory}:${original}`
    await expect(Effect.runPromise(stopProcessGroup(child.pid!, token))).rejects.toMatchObject({
      reason: { cause: expect.stringMatching(/refused/) },
    })
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  } finally {
    process.env.PATH = original
    child.kill("SIGKILL")
    await done
  }
})

test("live groups with missing or changed ownership refuse cleanup", async () => {
  const child = start()
  const done = new Promise((resolve) => child.on("close", resolve))
  try {
    for (const ownership of [undefined, "b".repeat(32)]) {
      await expect(Effect.runPromise(stopProcessGroup(child.pid!, ownership))).rejects.toMatchObject({
        reason: { cause: expect.stringMatching(/refused/) },
      })
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
    }
  } finally {
    child.kill("SIGKILL")
    await done
  }
})

test("owned cleanup proves exit while a parent retains a zombie", async () => {
  const parent = spawn("python3", [
    "-u",
    "-c",
    `
import subprocess, sys
child = subprocess.Popen([sys.argv[1], '-e', 'setInterval(()=>{},1000)', sys.argv[2]], start_new_session=True)
print(child.pid, flush=True)
sys.stdin.read()
child.wait()
`,
    process.execPath,
    `agentrun-worker-${token}`,
  ])
  const done = new Promise((resolve) => parent.on("close", resolve))
  const pid = await new Promise<number>((resolve) =>
    parent.stdout.once("data", (chunk) => resolve(Number(String(chunk))))
  )
  try {
    await Effect.runPromise(stopProcessGroup(pid, token))
    expect(() => process.kill(pid, 0)).not.toThrow()
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^Z/)
    console.info(`OS process evidence: retained worker state ${result.stdout.trim()}`)
  } finally {
    writeFileSync(
      join(process.env.AGENTRUN_TEST_EVIDENCE ?? tmpdir(), "zombie-process.json"),
      JSON.stringify({
        pid,
        table: spawnSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8" }).stdout,
      }),
    )
    try {
      process.kill(-pid, "SIGKILL")
    } catch { /* already exited */ }
    parent.stdin.end()
    await done
  }
}, 10000)
