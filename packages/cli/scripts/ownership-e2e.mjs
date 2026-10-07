import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const cli = realpathSync(process.argv[2])
const root = resolve(process.argv[3])
const hook = fileURLToPath(new URL("../test/fixtures/sdk-hooks.mjs", import.meta.url))
const selected = process.argv[4]
mkdirSync(root, { recursive: false })
const outcomes = []
const fixture = (name) => {
  const directory = join(root, name)
  const repo = join(directory, "repo")
  const home = join(directory, "home")
  mkdirSync(repo, { recursive: true })
  mkdirSync(home)
  const log = join(directory, "sdk.jsonl")
  const commands = []
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USER: "fixture",
    TMPDIR: directory,
    XDG_CONFIG_HOME: join(home, "config"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
    AGENTRUN_SDK_FIXTURE_LOG: log,
    NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
  }
  const exec = (executable, args, cwd = repo) => {
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 60000 })
    commands.push({
      executable,
      args,
      cwd,
      code: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    })
    writeFileSync(join(directory, "commands.json"), JSON.stringify(commands, null, 2))
    return result
  }
  const git = (...args) => {
    const result = exec("git", args)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const command = (args, code = 0, cwd = repo) => {
    const result = exec(process.execPath, [cli, ...args], cwd)
    assert.equal(result.status, code, `${args.join(" ")}\n${result.stderr}`)
    return result
  }
  const stateFile = (id, cwd = repo) => join(cwd, ".agentrun/runs", id, "state.json")
  const state = (id, cwd = repo) => JSON.parse(readFileSync(stateFile(id, cwd), "utf8"))
  const records = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
  const tasks = (filename, prompt = "no-change", taskId = "change", cwd = repo) =>
    writeFileSync(join(cwd, filename), `## ${taskId}: ${taskId}\n${prompt}\n`)
  git("init", "-q")
  git("config", "commit.gpgsign", "false")
  writeFileSync(join(repo, ".gitignore"), ".agentrun/\n")
  writeFileSync(join(repo, "seed"), "base\n")
  git("add", ".")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "base")
  tasks("TASKS.md")
  return { directory, repo, env, git, exec, command, stateFile, state, records, tasks }
}
const scenario = (name, run) => {
  if (selected !== undefined && selected !== name) return
  const f = fixture(name)
  try {
    run(f)
    outcomes.push({ name, result: "passed", fixtureCalls: f.records().length })
  } catch (error) {
    outcomes.push({
      name,
      result: "failed",
      message: error.message,
      stack: error.stack,
      fixtureCalls: f.records().length,
    })
  }
  writeFileSync(
    join(root, "proof.json"),
    JSON.stringify(
      {
        cli,
        cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
        node: process.version,
        paidProviderCalls: 0,
        outcomes,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(outcomes.at(-1)))
}

for (const mode of ["failed-retry", "interrupted-missing", "linked-checkout"]) {
  scenario(mode, (f) => {
    const first = "first-0001"
    const second = "second-0001"
    const branch = "agentrun/change-0001"
    const lock = join(f.repo, ".git/refs/heads", `${branch}.lock`)
    mkdirSync(join(f.repo, ".git/refs/heads/agentrun"), { recursive: true })
    writeFileSync(lock, "fixture ref lock")
    f.command(["run", "TASKS.md", "--run-id", first, "--json"], 1)
    const saved = f.state(first)
    assert.equal(saved.status.change._tag, "failed")
    assert.equal(f.records().length, 0)
    assert.equal(f.git("branch", "--list", branch), "")
    assert.equal(existsSync(saved.worktrees.change.path), false)
    unlinkSync(lock)
    if (mode === "interrupted-missing") {
      saved.status.change = { _tag: "interrupted", attempt: 1 }
      saved.taskReports.change = { phase: "unfinished", attempt: 1, eventOffset: 0, toolsStarted: false }
      writeFileSync(f.stateFile(first), JSON.stringify(saved))
      writeFileSync(join(f.directory, "injection.txt"), "Synthesized interrupted checkpoint before Git creation.\n")
    }
    const other = mode === "linked-checkout" ? join(f.directory, "linked") : f.repo
    if (other !== f.repo) f.git("worktree", "add", "-b", "linked", other, "HEAD")
    f.tasks("SECOND.md", "write-bytes", "change", other)
    f.command(["run", "SECOND.md", "--run-id", second, "--json"], 0, other)
    const refs = f.git("show-ref")
    const bytes = readFileSync(f.stateFile(first))
    const delivery = JSON.parse(f.command(["report", second, "--json"], 0, other).stdout)
    const resumed = f.command([
      "resume",
      first,
      ...(mode === "interrupted-missing" ? [] : ["--retry-failed"]),
      "--json",
    ], 1)
    assert.match(resumed.stderr, /ownership/i)
    assert.match(resumed.stderr, /preserve|inspect/i)
    assert.equal(f.records().length, 1)
    assert.deepEqual(readFileSync(f.stateFile(first)), bytes)
    assert.equal(f.git("show-ref"), refs)
    assert.equal(f.git("rev-parse", `refs/heads/${branch}`), delivery.taskReports.change.deliveryCommit)
    assert.equal(existsSync(saved.worktrees.change.path), false)
  })
}

for (const packed of [false, true]) {
  scenario(`case-${packed ? "packed" : "loose"}`, (f) => {
    f.tasks("TASKS.md", "write-bytes")
    f.command(["run", "TASKS.md", "--run-id", "first-A1B2", "--json"])
    if (packed) f.git("pack-refs", "--all", "--prune")
    const tip = f.git("rev-parse", "refs/heads/agentrun/change-A1B2")
    const refs = f.git("show-ref")
    const state = readFileSync(f.stateFile("first-A1B2"))
    const result = f.command(["run", "TASKS.md", "--run-id", "second-a1b2", "--json"], 2)
    assert.match(result.stderr, /collision/i)
    assert.equal(existsSync(f.stateFile("second-a1b2")), false)
    assert.equal(f.records().length, 1)
    assert.equal(f.git("rev-parse", "refs/heads/agentrun/change-A1B2"), tip)
    assert.equal(f.git("show-ref"), refs)
    assert.deepEqual(readFileSync(f.stateFile("first-A1B2")), state)
  })
}

for (const linked of [false, true]) {
  scenario(`run-id-${linked ? "linked" : "case"}`, (f) => {
    f.command(["run", "TASKS.md", "--run-id", "First-A1B2", "--json"])
    const before = readFileSync(f.stateFile("First-A1B2"))
    const other = linked ? join(f.directory, "linked") : f.repo
    if (linked) f.git("worktree", "add", "-b", "linked", other, "HEAD")
    f.tasks("OTHER.md", "no-change", "other", other)
    const result = f.command(["run", "OTHER.md", "--run-id", "first-a1b2", "--json"], 2, other)
    assert.match(result.stderr, /already exists/i)
    assert.equal(f.records().length, 1)
    assert.deepEqual(readFileSync(f.stateFile("First-A1B2")), before)
    assert.equal(f.git("branch", "--list", "agentrun/other-*"), "")
  })
}

scenario("empty-reservation", (f) => {
  const directory = join(f.repo, ".agentrun/runs/empty-0042")
  mkdirSync(directory, { recursive: true })
  for (const args of [["run", "TASKS.md", "--run-id", "empty-0042", "--json"], ["resume", "empty-0042", "--json"]]) {
    const result = f.command(args, 2)
    assert.match(result.stderr, /reserv/i)
    assert.match(result.stderr, /preserve/i)
    assert.match(result.stderr, /inspect/i)
    assert.ok(!result.stderr.includes("use resume with this exact ID"))
  }
  assert.deepEqual(readdirSync(directory), [])
  assert.equal(f.records().length, 0)
  assert.equal(f.git("branch", "--list", "agentrun/*"), "")
})

scenario("legacy-state", (f) => {
  f.command(["run", "TASKS.md", "--run-id", "legacy-0042", "--keep-worktrees", "--json"])
  const ownership = join(f.repo, ".git/agentrun/ownership")
  if (existsSync(ownership)) renameSync(ownership, join(f.directory, "saved-ownership"))
  const before = readFileSync(f.stateFile("legacy-0042"))
  const saved = f.state("legacy-0042")
  writeFileSync(join(saved.worktrees.change.path, "keep"), "preserve legacy work\n")
  const refs = f.git("show-ref")
  const result = f.command(["resume", "legacy-0042", "--json"], 1)
  assert.match(result.stderr, /ownership/i)
  assert.match(result.stderr, /legacy|unproved|unproven/i)
  assert.deepEqual(readFileSync(f.stateFile("legacy-0042")), before)
  assert.equal(f.git("show-ref"), refs)
  assert.equal(readFileSync(join(saved.worktrees.change.path, "keep"), "utf8"), "preserve legacy work\n")
  f.command(["report", "legacy-0042", "--json"])
  assert.equal(f.records().length, 1)
})

scenario("crash-before-proof", (f) => {
  const injection = join(f.directory, "crash.cjs")
  const marker = join(f.directory, "crashed")
  writeFileSync(
    injection,
    `
const fs = require('node:fs');
const {syncBuiltinESMExports} = require('node:module');
const original = fs.writeFile;
fs.writeFile = function(target, ...args) {
  if (String(target).includes('/agentrun/ownership/branches/') && !fs.existsSync(${JSON.stringify(marker)})) {
    fs.writeFileSync(${JSON.stringify(marker)}, String(target));
    process.kill(process.pid, 'SIGKILL');
  }
  return original.call(this, target, ...args);
};
syncBuiltinESMExports();
`,
  )
  f.env.NODE_OPTIONS += ` --require=${injection}`
  const crashed = f.exec(process.execPath, [cli, "run", "TASKS.md", "--run-id", "crash-0042", "--json"])
  assert.equal(crashed.signal, "SIGKILL")
  assert.equal(existsSync(marker), true)
  const saved = f.state("crash-0042")
  const before = readFileSync(f.stateFile("crash-0042"))
  assert.equal(existsSync(saved.worktrees.change.path), true)
  assert.equal(f.git("rev-parse", saved.worktrees.change.branch), saved.baseSha)
  const result = f.command(["resume", "crash-0042", "--json"], 1)
  assert.match(result.stderr, /ownership/i)
  assert.deepEqual(readFileSync(f.stateFile("crash-0042")), before)
  assert.equal(existsSync(saved.worktrees.change.path), true)
  assert.equal(f.records().length, 0)
})

scenario("corrupt-proof-before-delivery", (f) => {
  const id = "corrupt-0042"
  f.command(["run", "TASKS.md", "--run-id", id, "--keep-worktrees", "--json"])
  const saved = f.state(id)
  saved.status.change = { _tag: "running", attempt: 1, startedAt: "2026-10-07T00:00:00.000Z" }
  saved.taskReports.change.phase = "completed"
  writeFileSync(f.stateFile(id), JSON.stringify(saved))
  const directory = join(f.repo, ".git/agentrun/ownership/branches")
  const files = readdirSync(directory)
  assert.equal(files.length, 1)
  const receipt = join(directory, files[0])
  writeFileSync(join(f.directory, "original-receipt.json"), readFileSync(receipt))
  writeFileSync(receipt, "partial ownership record")
  const state = readFileSync(f.stateFile(id))
  const refs = f.git("show-ref")
  const result = f.command(["resume", id, "--json"], 1)
  assert.match(result.stderr, /ownership/i)
  assert.deepEqual(readFileSync(f.stateFile(id)), state)
  assert.equal(f.git("show-ref"), refs)
  assert.equal(existsSync(saved.worktrees.change.path), true)
  assert.equal(f.records().length, 1)
})

for (const missing of [false, true]) {
  scenario(`proved-${missing ? "missing" : "dirty"}`, (f) => {
    const id = "proved-0042"
    f.command(["run", "TASKS.md", "--run-id", id, "--keep-worktrees", "--json"])
    const saved = f.state(id)
    saved.status.change = { _tag: "interrupted", attempt: 1 }
    saved.taskReports.change = { phase: "unfinished", attempt: 1, eventOffset: 0, toolsStarted: true }
    writeFileSync(f.stateFile(id), JSON.stringify(saved))
    writeFileSync(join(f.directory, "injection.txt"), "Synthesized interrupted checkpoint with proved Git creation.\n")
    if (missing) f.git("worktree", "remove", saved.worktrees.change.path)
    else writeFileSync(join(saved.worktrees.change.path, "keep"), "preserve owned work\n")
    f.command(["resume", id, "--json"])
    assert.equal(f.state(id).status.change._tag, "succeeded")
    assert.equal(f.records().length, 2)
    if (!missing) assert.equal(f.git("show", `${saved.worktrees.change.branch}:keep`), "preserve owned work")
  })
}

assert.ok(outcomes.length > 0, "No scenario selected")
process.exitCode = outcomes.some((outcome) => outcome.result === "failed") ? 1 : 0
