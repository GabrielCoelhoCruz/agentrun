import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const cli = realpathSync(process.argv[2])
const root = resolve(process.argv[3])
const hook = fileURLToPath(new URL("../test/fixtures/sdk-hooks.mjs", import.meta.url))
mkdirSync(root, { recursive: false })
const repo = join(root, "repo")
const home = join(root, "home")
mkdirSync(repo)
mkdirSync(home)
const log = join(root, "sdk.jsonl")
const commands = []
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USER: "fixture",
  TMPDIR: root,
  XDG_CONFIG_HOME: join(home, "config"),
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  PI_CODING_AGENT_DIR: join(home, "pi"),
  AGENTRUN_SDK_FIXTURE_LOG: log,
  NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
}
const run = (executable, args, code = 0) => {
  const value = spawnSync(executable, args, { cwd: repo, env, encoding: "utf8" })
  commands.push({
    executable,
    args,
    cwd: repo,
    code: value.status,
    signal: value.signal,
    stdout: value.stdout,
    stderr: value.stderr,
  })
  writeFileSync(join(root, "commands.json"), JSON.stringify(commands, null, 2))
  assert.equal(value.status, code, value.stderr)
  return value.stdout.trim()
}
const git = (...args) => run("git", args)
const command = (args, code = 0) => run(process.execPath, [cli, ...args], code)
const records = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : []
const reports = []
git("init", "-q")
git("config", "commit.gpgsign", "false")
writeFileSync(join(repo, ".gitignore"), ".agentrun/\n")
writeFileSync(join(repo, "seed"), "base\n")
git("add", ".")
git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "base")
const base = git("rev-parse", "HEAD")
command(["--help"])
for (const [agent, suffix] of [["claude-code", "1001"], ["pi", "1002"]]) {
  const id = `installed-review-${suffix}`
  writeFileSync(
    join(repo, "TASKS.md"),
    `---\nagent: ${agent}\ntools: read-only\n---\n## review: Review\nrestricted-review\n`,
  )
  command(["run", "TASKS.md", "--run-id", id, "--json", "--concurrency", "1"])
  const report = JSON.parse(command(["report", id, "--json"]))
  assert.equal(report.runId, id)
  assert.equal(report.tasks[0].tools, "read-only")
  assert.equal(report.status.review._tag, "succeeded")
  assert.equal(report.taskReports.review.deliveryCommit, base)
  assert.deepEqual(JSON.parse(report.taskReports.review.result), { verdict: "accepted", findings: [] })
  const patch = readFileSync(join(repo, ".agentrun/runs", id, "tasks/review/diff.patch"))
  assert.equal(patch.length, 0)
  assert.equal(report.taskReports.review.patchSha256, createHash("sha256").update(patch).digest("hex"))
  const count = records().length
  const before = readFileSync(join(repo, ".agentrun/runs", id, "state.json"))
  command(["run", "TASKS.md", "--run-id", id, "--json"], 2)
  assert.deepEqual(readFileSync(join(repo, ".agentrun/runs", id, "state.json")), before)
  command(["resume", id, "--json"])
  assert.equal(records().length, count)
  assert.deepEqual(JSON.parse(command(["report", id, "--json"])), report)
  reports.push(report)
}
writeFileSync(join(repo, "TASKS.md"), "## change: Change\nwrite-bytes\n")
command(["run", "TASKS.md", "--run-id", "installed-write-2001", "--json"])
const delivery = JSON.parse(command(["report", "installed-write-2001", "--json"]))
assert.notEqual(delivery.taskReports.change.deliveryCommit, base)
git("merge-base", "--is-ancestor", base, delivery.taskReports.change.deliveryCommit)
const file = spawnSync("git", ["show", `${delivery.taskReports.change.deliveryCommit}:bytes.bin`], { cwd: repo, env })
assert.equal(file.status, 0)
assert.deepEqual(file.stdout, Buffer.from([0, 255, 10, 16]))
const patch = readFileSync(join(repo, ".agentrun/runs/installed-write-2001/tasks/change/diff.patch"))
assert.equal(createHash("sha256").update(patch).digest("hex"), delivery.taskReports.change.patchSha256)
const refs = git("show-ref")
command(["run", "TASKS.md", "--run-id", "collision-2001", "--json"], 2)
assert.equal(git("show-ref"), refs)
assert.equal(existsSync(join(repo, ".agentrun/runs/collision-2001")), false)
assert.equal(records().length, 3)
for (const record of records()) {
  const process = spawnSync("ps", ["-p", String(record.pid), "-o", "command="], { encoding: "utf8" })
  assert.ok(process.status === 1 || !process.stdout.includes("agentrun-worker-"), `worker ${record.pid} remains`)
}
assert.equal(git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1)
writeFileSync(
  join(root, "proof.json"),
  JSON.stringify(
    {
      cli,
      base,
      reports,
      delivery,
      providers: records(),
      kind: "deterministic installed CLI and SDK tool constraints",
      realProviderVerified: false,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ result: "passed", cli, root, providerCalls: records().length, paidProviderCalls: 0 }))
