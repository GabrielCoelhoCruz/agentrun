import { Effect } from "effect"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { expect, test, vi } from "vitest"
import { stopProcessGroup } from "../src/ProcessGroup.js"

const token = "a".repeat(32)
const start = () =>
  spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", `agentrun-worker-${token}`], {
    detached: true,
    stdio: "ignore",
  })

test.each(["exit", "timeout"])("native process-table failure (%s) retains a redacted cause", async (mode) => {
  const directory = mkdtempSync(join(tmpdir(), "agentrun-ps-failure-"))
  const original = process.env.PATH
  const child = start()
  const done = once(child, "close")
  writeFileSync(
    join(directory, "ps"),
    `#!/bin/sh\nprintf 'Permission denied: /private/fixture TOKEN=private-token\\n' >&2\n${
      mode === "exit" ? "exit 23" : "exec node -e 'setInterval(()=>{},1000)'"
    }\n`,
    { mode: 0o755 },
  )
  try {
    process.env.PATH = `${directory}:${original}`
    const failure = await Effect.runPromise(stopProcessGroup(child.pid!, token)).then(
      () => { throw new Error("Expected process-table failure") },
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ reason: { _tag: "Unknown", module: "ProcessGroup", method: "table" } })
    const text = inspect(failure, { depth: 8 })
    expect(text).toContain('"timeoutMs":5000')
    expect(text).toContain(mode === "exit" ? '"code":23' : '"signal":"SIGTERM"')
    if (mode === "timeout") expect(text).toContain('"killed":true')
    expect(text).toContain("permission denied")
    expect(text).not.toMatch(/private-token|\/private\/fixture|TOKEN=/)
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
    if (process.env.AGENTRUN_TEST_EVIDENCE) {
      writeFileSync(join(process.env.AGENTRUN_TEST_EVIDENCE, `process-table-${mode}.json`), JSON.stringify({ mode, error: text }))
    }
  } finally {
    process.env.PATH = original
    child.kill("SIGKILL")
    await done
    rmSync(directory, { recursive: true })
  }
}, 15000)

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

test("owned cleanup accepts a complete long multiline Git leader command", async () => {
  const argument = `argument-start ${"space separated words ".repeat(1024)}\tline one\nline two argument-end`
  const child = spawn(process.execPath, [
    "-e",
    `
const timer = setInterval(() => {}, 1000)
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
`,
    "--",
    argument,
    `agentrun-git-${token}`,
  ], { detached: true, stdio: "ignore" })
  const done = once(child, "close")
  try {
    const snapshot = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,command=", "-ww"], { encoding: "utf8" })
    expect(snapshot.status).toBe(0)
    const rows = snapshot.stdout.split("\n").filter((line) => line.trim().split(/\s+/)[0] === String(child.pid))
    if (process.env.AGENTRUN_TEST_EVIDENCE) {
      writeFileSync(join(process.env.AGENTRUN_TEST_EVIDENCE, "long-command.txt"), rows.join("\n"))
    }
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("space separated words ".repeat(1024))
    expect(rows[0]).toContain("argument-start")
    expect(rows[0]).toContain("argument-end")
    expect(rows[0]!.trim().split(/\s+/).at(-1)).toBe(`agentrun-git-${token}`)
    await Effect.runPromise(stopProcessGroup(child.pid!, token, "git"))
    await done
    expect(() => process.kill(child.pid!, 0)).toThrow()
  } finally {
    child.kill("SIGKILL")
    await done
  }
})

test.each([
  { name: "missing command", command: "" },
  { name: "unavailable command", command: "(node)" },
  { name: "command cut before the marker ends", command: `node agentrun-worker-${token.slice(0, 16)}` },
  { name: "wrong marker kind", command: `node agentrun-git-${token}` },
  { name: "marker with an attached prefix", command: `node prefix-agentrun-worker-${token}` },
  { name: "marker with an attached suffix", command: `node agentrun-worker-${token}-suffix` },
  { name: "marker only on another row", command: "node foreign-command" },
  { name: "missing leader row", command: `node agentrun-worker-${token}`, leader: "missing" },
  { name: "leader in a different group", command: `node agentrun-worker-${token}`, leader: "wrong-group" },
  { name: "duplicate PID with conflicting commands", command: `node agentrun-worker-${token}`, leader: "duplicate" },
])("$name refuses cleanup and preserves both real processes", async ({ command, leader }) => {
  const directory = mkdtempSync(join(tmpdir(), "agentrun-ps-evidence-"))
  const original = process.env.PATH
  const child = start()
  const sentinel = start()
  const done = once(child, "close")
  const sentinelDone = once(sentinel, "close")
  const childRow = `${child.pid} ${process.pid} ${leader === "wrong-group" ? sentinel.pid : child.pid} S ${command}`
  const sentinelRow = `${sentinel.pid} ${process.pid} ${
    leader === "missing" || leader === "wrong-group" ? child.pid : sentinel.pid
  } S node agentrun-worker-${token}`
  const rows = [sentinelRow]
  if (leader !== "missing") rows.push(childRow)
  if (leader === "duplicate") rows.push(`${child.pid} ${process.pid} ${child.pid} S node changed-command`)
  try {
    writeFileSync(
      join(directory, "ps"),
      `#!/bin/sh
if ! kill -0 ${child.pid} 2>/dev/null; then exec /bin/ps "$@"; fi
case "$1" in
  -axo)
    cat <<'AGENTRUN_TABLE'
${rows.join("\n")}
AGENTRUN_TABLE
    ;;
  -p)
    cat <<'AGENTRUN_COMMAND'
${command}
AGENTRUN_COMMAND
    ;;
  *) exec /bin/ps "$@";;
esac
`,
      { mode: 0o755 },
    )
    process.env.PATH = `${directory}:${original}`
    const result = await Effect.runPromiseExit(stopProcessGroup(child.pid!, token))
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow()
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
    expect(result._tag).toBe("Failure")
  } finally {
    process.env.PATH = original
    child.kill("SIGKILL")
    sentinel.kill("SIGKILL")
    await Promise.all([done, sentinelDone])
    rmSync(directory, { recursive: true })
  }
})

test("separate cleanup calls reject changed leader command evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentrun-ps-fresh-"))
  const original = process.env.PATH
  const child = start()
  const done = once(child, "close")
  try {
    for (const command of [`node agentrun-worker-${token}`, "node changed-command"]) {
      writeFileSync(
        join(directory, "ps"),
        `#!/bin/sh
case "$1" in
  -axo) echo '${child.pid} ${process.pid} ${child.pid} S ${command}'
         echo '999999 ${child.pid} 0 S';;
  -p) echo '${command}';;
  *) exec /bin/ps "$@";;
esac
`,
        { mode: 0o755 },
      )
      process.env.PATH = `${directory}:${original}`
      await expect(Effect.runPromise(stopProcessGroup(child.pid!, token))).rejects.toMatchObject({
        reason: { cause: expect.stringMatching(command.includes(token) ? /unowned group/ : /ownership changed/) },
      })
      expect(() => process.kill(child.pid!, 0)).not.toThrow()
    }
  } finally {
    process.env.PATH = original
    child.kill("SIGKILL")
    await done
    rmSync(directory, { recursive: true })
  }
})

test("owned cleanup stops a nested detached child and preserves a foreign sentinel", async () => {
  const leader = spawn(process.execPath, [
    "-e",
    `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', "process.on('disconnect', () => process.exit(70)); process.send('ready'); setInterval(() => {}, 1000)"], {
  detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
})
process.on('SIGTERM', () => {})
child.once('message', () => process.send(child.pid))
child.once('close', (code, signal) => {
  process.send({ pid: child.pid, code, signal }, () => process.exit(0))
})
process.stdin.resume()
process.stdin.on('end', () => child.kill('SIGKILL'))
`,
    `agentrun-worker-${token}`,
  ], { detached: true, stdio: ["pipe", "ignore", "ignore", "ipc"] })
  const sentinel = start()
  const done = once(leader, "close")
  const sentinelDone = once(sentinel, "close")
  let receipt: unknown
  leader.on("message", (message) => {
    if (typeof message === "object") receipt = message
  })
  try {
    const [nestedPid] = await once(leader, "message", { signal: AbortSignal.timeout(4000) })
    expect(Number.isSafeInteger(nestedPid)).toBe(true)
    const membership = spawnSync("/bin/ps", ["-p", String(nestedPid), "-o", "pid=,ppid=,pgid="], { encoding: "utf8" })
    expect(membership.status).toBe(0)
    expect(membership.stdout.trim().split(/\s+/).map(Number)).toEqual([nestedPid, leader.pid, nestedPid])
    await Effect.runPromise(stopProcessGroup(leader.pid!, token))
    await done
    expect(receipt).toEqual({ pid: nestedPid, code: null, signal: "SIGTERM" })
    expect(() => process.kill(nestedPid, 0)).toThrow()
    expect(() => process.kill(leader.pid!, 0)).toThrow()
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow()
    if (process.env.AGENTRUN_TEST_EVIDENCE) {
      writeFileSync(
        join(process.env.AGENTRUN_TEST_EVIDENCE, "nested-processes.json"),
        JSON.stringify(
          {
            leader: leader.pid,
            nested: receipt,
            sentinel: sentinel.pid,
            sentinelAliveAfterCleanup: true,
          },
          null,
          2,
        ),
      )
    }
  } finally {
    leader.stdin!.end()
    await done
    sentinel.kill("SIGKILL")
    await sentinelDone
  }
})

const stubborn = async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{});process.on('message',()=>process.exit(0));process.send('ready');setInterval(()=>{},1000)",
    `agentrun-worker-${token}`,
  ], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
  const done = once(child, "close")
  await once(child, "message", { signal: AbortSignal.timeout(4000) })
  return { child, done }
}
const dispose = async (child: ReturnType<typeof spawn>, done: Promise<unknown>) => {
  const row = spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "pgid=,command=", "-ww"], { encoding: "utf8" })
  if (
    row.status === 0 && row.stdout.trim().split(/\s+/)[0] === String(child.pid)
    && row.stdout.trim().split(/\s+/).includes(`agentrun-worker-${token}`)
  ) {
    process.kill(-child.pid!, "SIGKILL")
  }
  await done
}

test("two concurrent cleaners settle the same real SIGTERM-ignoring group", async () => {
  for (let iteration = 0; iteration < 10; iteration++) {
    const { child, done } = await stubborn()
    try {
      const results = await Promise.allSettled([
        Effect.runPromise(stopProcessGroup(child.pid!, token)),
        Effect.runPromise(stopProcessGroup(child.pid!, token)),
      ])
      const diagnostics = {
        platform: process.platform,
        iteration,
        pid: child.pid,
        results: inspect(results, { depth: 8 }),
      }
      if (process.env.AGENTRUN_TEST_EVIDENCE) {
        writeFileSync(
          join(process.env.AGENTRUN_TEST_EVIDENCE, `concurrent-stop-${iteration}.json`),
          JSON.stringify(diagnostics, null, 2),
        )
      }
      expect(results.map((r) => r.status), diagnostics.results).toEqual(["fulfilled", "fulfilled"])
      await done
      expect(() => process.kill(child.pid!, 0)).toThrow()
      console.info(JSON.stringify({ platform: process.platform, iteration, pid: child.pid, results }))
    } finally {
      await dispose(child, done)
    }
  }
}, 60000)

test.each(["live", "exits"])("permission denial with a %s group requires bounded exit proof", async (state) => {
  const { child, done } = await stubborn()
  const realKill = process.kill.bind(process)
  let timer: ReturnType<typeof setTimeout> | undefined
  const signals: Array<string> = []
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -child.pid! && signal !== 0) {
      signals.push(String(signal))
      if (state === "exits" && timer === undefined) timer = setTimeout(() => child.send("exit"), 100)
      throw Object.assign(new Error("permission denied"), { code: "EPERM" })
    }
    return realKill(pid, signal)
  })
  try {
    const started = performance.now()
    const result = await Effect.runPromiseExit(stopProcessGroup(child.pid!, token))
    if (state === "live") {
      expect(result._tag).toBe("Failure")
      expect(performance.now() - started).toBeGreaterThanOrEqual(1500)
      expect(() => realKill(child.pid!, 0)).not.toThrow()
    } else {
      expect(result._tag).toBe("Success")
      await done
      expect(() => realKill(child.pid!, 0)).toThrow()
    }
    expect(signals).toEqual(["SIGTERM"])
  } finally {
    spy.mockRestore()
    clearTimeout(timer)
    await dispose(child, done)
  }
}, 15000)

test("changed leader evidence before escalation prevents another signal", async () => {
  const { child, done } = await stubborn()
  const directory = mkdtempSync(join(tmpdir(), "agentrun-ps-escalation-"))
  const original = process.env.PATH
  const realKill = process.kill.bind(process)
  const signals: Array<string> = []
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -child.pid! && signal !== 0) {
      signals.push(String(signal))
      writeFileSync(
        join(directory, "ps"),
        `#!/bin/sh\necho '${child.pid} ${process.pid} ${child.pid} S node changed-command'\n`,
        { mode: 0o755 },
      )
      process.env.PATH = `${directory}:${original}`
    }
    return realKill(pid, signal)
  })
  try {
    const result = await Effect.runPromiseExit(stopProcessGroup(child.pid!, token))
    expect(result._tag).toBe("Failure")
    expect(signals).toEqual(["SIGTERM"])
    expect(() => realKill(child.pid!, 0)).not.toThrow()
  } finally {
    spy.mockRestore()
    process.env.PATH = original
    await dispose(child, done)
    rmSync(directory, { recursive: true })
  }
}, 15000)

test("a group whose command disappears during exit needs no unproved escalation", async () => {
  const { child, done } = await stubborn()
  const directory = mkdtempSync(join(tmpdir(), "agentrun-exiting-command-"))
  const original = process.env.PATH
  const signalled = join(directory, "signalled")
  const observed = join(directory, "observed")
  const realKill = process.kill.bind(process)
  const signals: Array<string> = []
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -child.pid! && signal !== 0) {
      signals.push(String(signal))
      writeFileSync(signalled, "owned signal sent")
    }
    return realKill(pid, signal)
  })
  let released = false
  const timer = setInterval(() => {
    if (!released && existsSync(observed)) {
      released = true
      child.send("exit")
    }
  }, 20)
  try {
    writeFileSync(
      join(directory, "ps"),
      `#!/bin/sh
case "$*" in
  *command=*)
    if [ -e '${signalled}' ]; then
      echo '${child.pid} ${process.pid} ${child.pid} S (node)'
      touch '${observed}'
      exit 0
    fi;;
esac
exec /bin/ps "$@"
`,
      { mode: 0o755 },
    )
    process.env.PATH = `${directory}:${original}`
    const result = await Effect.runPromiseExit(stopProcessGroup(child.pid!, token))
    expect(result._tag, inspect(result, { depth: 8 })).toBe("Success")
    expect(released).toBe(true)
    expect(signals).toEqual(["SIGTERM"])
    await done
    expect(() => realKill(child.pid!, 0)).toThrow()
  } finally {
    clearInterval(timer)
    spy.mockRestore()
    process.env.PATH = original
    await dispose(child, done)
    rmSync(directory, { recursive: true })
  }
}, 15000)
