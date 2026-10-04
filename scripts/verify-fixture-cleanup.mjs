import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../", import.meta.url))
const output = resolve(process.argv[2])
const scenario = process.argv[3] ?? "wait"
assert.ok(["wait", "assertion", "timeout", "success", "unknown", "reused"].includes(scenario))
mkdirSync(output)
const fixtures = join(output, "fixtures")
mkdirSync(fixtures)
const table = () => {
  const r = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8", timeout: 5000 })
  assert.equal(r.status, 0)
  return r.stdout.trim().split("\n").map(line => {
    const [pid, parent, group, state, ...command] = line.trim().split(/\s+/)
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state, command: command.join(" ") }
  })
}
const foreign = ["unknown", "reused"].includes(scenario)
  ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `agentrun-worker-${"f".repeat(32)}`], {
    detached: true,
    stdio: "ignore",
  })
  : undefined
const foreignDone = foreign && new Promise(resolve => foreign.on("exit", resolve))
const name = scenario === "wait"
  ? "^Ctrl-C persists two interrupted tasks and stops their marked children$"
  : "^fixture cleanup probe"
const args = [
  "node_modules/vitest/vitest.mjs",
  "run",
  "--project",
  "cli",
  "test/Cli.test.ts",
  "--maxWorkers",
  "1",
  "-t",
  name,
]
writeFileSync(
  join(output, "command.json"),
  JSON.stringify(
    {
      cwd: repo,
      node: process.execPath,
      args,
      scenario,
      head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim(),
      diff: spawnSync("git", ["diff"], { cwd: repo, encoding: "utf8" }).stdout,
    },
    null,
    2,
  ),
)
const p = spawn(process.execPath, args, {
  cwd: repo,
  env: {
    ...process.env,
    AGENTRUN_TEST_EVIDENCE: fixtures,
    AGENTRUN_CLEANUP_PROBE: scenario,
    ...(scenario === "wait" ? {} : { AGENTRUN_CLEANUP_CASE: scenario }),
    ...(foreign ? { AGENTRUN_FOREIGN_PID: String(foreign.pid) } : {}),
    NODE_OPTIONS: `--require=${join(repo, "scripts/fixture-cleanup-preload.cjs")}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let stdout = "", stderr = ""
p.stdout.on("data", x => {
  stdout += x
})
p.stderr.on("data", x => {
  stderr += x
})
const deadline = setTimeout(() => p.kill("SIGTERM"), 120000)
let records = [], identities = []
const f = join(fixtures, "case-1")
try {
  const code = await new Promise((resolve, reject) => {
    p.on("error", reject)
    p.on("close", resolve)
  })
  clearTimeout(deadline)
  writeFileSync(join(output, "vitest.stdout"), stdout)
  writeFileSync(join(output, "vitest.stderr"), stderr)
  records = readFileSync(join(f, "probe-processes.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  identities = records.flatMap(r => {
    const token = r.argv.find(arg => /^agentrun-worker-[a-f0-9]{32}$/.test(arg))
    return token ? [{ pgid: r.pid, processToken: token.slice("agentrun-worker-".length) }] : []
  })
  const runRoot = join(f, "repo/.agentrun/runs")
  const saved = JSON.parse(readFileSync(join(runRoot, readdirSync(runRoot)[0], "state.json"), "utf8"))
  const observed = table()
  const cli = records.filter(r => r.argv[1].endsWith("/fixtures/dist/entry.mjs"))
  const live = observed.filter(r =>
    !r.state.startsWith("Z") && (cli.some(c => r.pid === c.pid) || identities.some(w => r.group === w.pgid))
  )
  writeFileSync(join(output, "result.json"), JSON.stringify({ code, cli, identities, saved, live, observed }, null, 2))
  assert.equal(code, scenario === "success" ? 0 : 1, "inner Vitest exit must match injected outcome")
  assert.ok(
    readFileSync(join(f, scenario === "wait" ? "child-task0.hidden" : "child-task0"), "utf8").trim(),
    "real hold child started",
  )
  if (scenario === "wait") {
    assert.match(stdout + stderr, /Condition did not complete within 15 seconds/)
    assert.ok(readFileSync(join(f, "child-task1"), "utf8").trim(), "second real hold child started")
  }
  if (scenario === "assertion") assert.match(stdout + stderr, /injected assertion failure/)
  if (scenario === "timeout") {
    assert.match(stdout + stderr, /Test timed out/)
    assert.match(readFileSync(join(f, "late-result"), "utf8"), /closed/)
    assert.equal(cli.length, 1, "late continuation must not spawn a new CLI")
  }
  if (foreign) {
    assert.ok(observed.some(r => r.pid === foreign.pid && !r.state.startsWith("Z")), "unrelated group must survive")
    assert.match(stdout + stderr, /ownership|verified ownership token/)
  }
  assert.deepEqual(live, [], "fixture must leave no live CLI or worker group after Vitest finishes")
  console.log(`PASS: ${scenario} left zero owned processes`)
} finally {
  clearTimeout(deadline)
  const receipts = []
  if (existsSync(join(f, "probe-processes.jsonl"))) {
    records = readFileSync(join(f, "probe-processes.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  }
  for (const record of records) {
    const current = table().find(r => r.pid === record.pid && !r.state.startsWith("Z"))
    if (!current) continue
    const token = record.argv.find(arg => /^agentrun-worker-[a-f0-9]{32}$/.test(arg))
    if (token && current.group === record.pid && current.command.split(/\s+/).includes(token)) {
      process.kill(-record.pid, "SIGKILL")
      receipts.push({ ...current, signal: "SIGKILL", token })
    } else if (!token && current.command.includes(record.argv[1])) {
      process.kill(record.pid, "SIGKILL")
      receipts.push({ ...current, signal: "SIGKILL" })
    }
  }
  if (foreign && foreign.exitCode === null && foreign.signalCode === null) {
    const current = table().find(r =>
      r.pid === foreign.pid && r.command.split(/\s+/).includes(`agentrun-worker-${"f".repeat(32)}`)
    )
    if (current) foreign.kill("SIGKILL")
    await foreignDone
  }
  await delay(300)
  const remaining = table().filter(r =>
    !r.state.startsWith("Z") && records.some(record => r.pid === record.pid || r.group === record.pid)
  )
  writeFileSync(join(output, "cleanup.json"), JSON.stringify({ receipts, remaining }, null, 2))
  assert.deepEqual(remaining, [], "probe cleanup must leave zero owned resources")
}
