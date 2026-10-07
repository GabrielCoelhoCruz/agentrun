import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const source = fileURLToPath(new URL("../../../", import.meta.url))
const packageTarget = process.argv[2] === "--install"
const evidence = resolve(process.argv[3])
const selected = process.argv[4]
const setupCommands = []
const setup = (executable, args, cwd = source) => {
  const started = Date.now()
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL" })
  setupCommands.push({
    executable,
    args,
    cwd,
    elapsedMs: Date.now() - started,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  })
  writeFileSync(join(evidence, "setup-commands.json"), JSON.stringify(setupCommands, null, 2))
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  return result.stdout.trim()
}
let installedCli = process.argv[2]
let packageProof
if (packageTarget) {
  assert.match(process.version, /^v24\./, "Installed proof requires Node24")
  mkdirSync(evidence, { recursive: false })
  const head = setup("git", ["rev-parse", "HEAD"])
  const branch = setup("git", ["branch", "--show-current"])
  const base = setup("git", ["rev-parse", process.env.AGENTRUN_CANDIDATE_BASE ?? "HEAD^"])
  assert.equal(setup("git", ["status", "--porcelain"]), "", "Candidate checkout must be clean")
  const packs = join(evidence, "packs")
  const consumer = join(evidence, "consumer")
  mkdirSync(packs)
  mkdirSync(consumer)
  for (const name of ["core", "cli"]) {
    setup("pnpm", ["pack", "--pack-destination", packs], join(source, "packages", name))
  }
  const corePack = join(packs, "agentrun-core-0.1.0.tgz")
  const cliPack = join(packs, "agentrun-0.1.0.tgz")
  const { parse } = createRequire(new URL("../../core/package.json", import.meta.url))("yaml")
  const lock = parse(readFileSync(join(source, "pnpm-lock.yaml"), "utf8"))
  const overrides = { "@agentrun/core": `file:${corePack}` }
  for (const name of ["core", "cli"]) {
    for (const [dependency, entry] of Object.entries(lock.importers[`packages/${name}`].dependencies)) {
      if (dependency !== "@agentrun/core") overrides[dependency] = entry.version.split("(")[0]
    }
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { "@agentrun/core": `file:${corePack}`, agentrun: `file:${cliPack}` },
        pnpm: { overrides },
      },
      null,
      2,
    ),
  )
  setup("pnpm", ["install"], consumer)
  setup("pnpm", ["install", "--frozen-lockfile"], consumer)
  const coreRoot = realpathSync(join(consumer, "node_modules/@agentrun/core"))
  const cliRoot = realpathSync(join(consumer, "node_modules/agentrun"))
  const bindings = {
    core: coreRoot,
    cli: cliRoot,
    cliCore: realpathSync(join(dirname(cliRoot), "@agentrun/core")),
    coreEffect: realpathSync(join(dirname(dirname(coreRoot)), "effect")),
    cliEffect: realpathSync(join(dirname(cliRoot), "effect")),
  }
  assert.equal(bindings.core, bindings.cliCore, "Installed CLI must use candidate core")
  assert.equal(bindings.coreEffect, bindings.cliEffect, "CLI/core must share Effect")
  const hashes = {}
  const compare = (built, installed) => {
    for (const name of readdirSync(built)) {
      const from = join(built, name)
      const to = join(installed, name)
      if (lstatSync(from).isDirectory()) compare(from, to)
      else {
        assert.deepEqual(readFileSync(to), readFileSync(from), `Installed bytes differ: ${name}`)
        hashes[from] = createHash("sha256").update(readFileSync(from)).digest("hex")
        hashes[to] = hashes[from]
      }
    }
  }
  compare(join(source, "packages/core/dist"), join(coreRoot, "dist"))
  compare(join(source, "packages/cli/dist"), join(cliRoot, "dist"))
  for (const file of [corePack, cliPack, join(consumer, "pnpm-lock.yaml")]) {
    hashes[file] = createHash("sha256").update(readFileSync(file)).digest("hex")
  }
  packageProof = {
    head,
    base,
    branch,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pnpm: setup("pnpm", ["--version"]),
    bindings,
    hashes,
  }
  writeFileSync(join(evidence, "package-proof.json"), JSON.stringify(packageProof, null, 2))
  installedCli = join(cliRoot, "dist/bin.mjs")
}
const cli = realpathSync(installedCli)
const root = packageTarget ? join(evidence, "journeys") : evidence
const hook = fileURLToPath(new URL("../test/fixtures/sdk-hooks.mjs", import.meta.url))
mkdirSync(root, { recursive: false })
const outcomes = []
const declared = []
const fixture = (name) => {
  const directory = join(root, name)
  let repo = join(directory, "repo")
  let home = join(directory, "home")
  mkdirSync(repo, { recursive: true })
  mkdirSync(home)
  repo = realpathSync(repo)
  home = realpathSync(home)
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
    const started = Date.now()
    const result = spawnSync(executable, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: env.AGENTRUN_REFUSAL ? 10000 : 60000,
      killSignal: "SIGKILL",
    })
    commands.push({
      elapsedMs: Date.now() - started,
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
  declared.push(name)
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
        packageProof,
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

// Hash filesystem bytes and identities without following or reading special files.
const snapshot = (directory, excluded = new Set()) => {
  const files = {}
  const visit = (file) => {
    if (excluded.has(file)) return
    const stat = lstatSync(file)
    if (stat.isDirectory()) {
      files[file] = {
        mode: stat.mode,
        ino: stat.ino,
        dev: stat.dev,
        entries: readdirSync(file).filter((name) => !excluded.has(join(file, name))).sort(),
      }
      for (const name of readdirSync(file).sort()) visit(join(file, name))
    } else {
      files[file] = {
        mode: stat.mode,
        size: stat.size,
        ino: stat.ino,
        dev: stat.dev,
        bytes: stat.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : null,
        link: stat.isSymbolicLink() ? readlinkSync(file) : null,
      }
    }
  }
  visit(directory)
  return files
}
const recordSnapshot = (file) => {
  const stat = lstatSync(file)
  return {
    mode: stat.mode,
    size: stat.size,
    ino: stat.ino,
    dev: stat.dev,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    bytes: stat.isFile() && stat.size <= 65536 ? createHash("sha256").update(readFileSync(file)).digest("hex") : null,
    link: stat.isSymbolicLink() ? readlinkSync(file) : null,
    entries: stat.isDirectory() ? readdirSync(file).sort() : null,
  }
}
const faults = [
  "fifo",
  "directory",
  "socket",
  "symlink",
  "empty",
  "malformed",
  "utf8",
  "at-limit",
  "below-limit",
  "oversized",
  "sparse",
  "wrong-version",
  "wrong-type",
  "missing-field",
  "extra-field",
  "foreign-runId",
  "foreign-repoRoot",
  "serialized",
  "replace-before-open",
  "device-before-open",
  "replace-after-open",
  "grow",
  "truncate",
  "same-size",
  "read-error",
  "premature-eof",
]
for (const record of ["reservation", "receipt"]) {
  for (
    const fault of [...faults, ...(record === "receipt" ? ["foreign-taskId", "foreign-path", "foreign-branch"] : [])]
  ) {
    scenario(`bounded-${record}-${fault}`, (f) => {
      const id = "bounded-0042"
      f.command(["run", "TASKS.md", "--run-id", id, "--keep-worktrees", "--json"])
      const saved = f.state(id)
      const file = record === "reservation"
        ? join(f.repo, ".git/agentrun/ownership/runs", id, "owner.json")
        : join(
          f.repo,
          ".git/agentrun/ownership/branches",
          readdirSync(join(f.repo, ".git/agentrun/ownership/branches"))[0],
        )
      const original = readFileSync(file)
      writeFileSync(join(f.directory, "original-record.json"), original)
      writeFileSync(join(saved.worktrees.change.path, "preserve"), "dirty owned workspace\n")
      writeFileSync(join(saved.worktrees.change.path, "large-preserve"), Buffer.alloc(70000, 42))
      const dynamic = [
        "replace-before-open",
        "device-before-open",
        "replace-after-open",
        "grow",
        "truncate",
        "same-size",
        "read-error",
        "premature-eof",
      ].includes(fault)
      const marker = join(f.directory, "injection.json")
      if (!dynamic) {
        if (["fifo", "directory", "socket", "symlink"].includes(fault)) {
          renameSync(file, file + ".original")
          if (fault === "fifo") assert.equal(f.exec("mkfifo", [file]).status, 0)
          if (fault === "directory") mkdirSync(file)
          if (fault === "symlink") symlinkSync(file + ".original", file)
          if (fault === "socket") {
            assert.equal(
              f.exec("python3", [
                "-c",
                "import os,socket,sys; os.chdir(os.path.dirname(sys.argv[1])); s=socket.socket(socket.AF_UNIX); s.bind(os.path.basename(sys.argv[1])); s.close()",
                file,
              ]).status,
              0,
            )
          }
        } else if (fault === "empty") writeFileSync(file, "")
        else if (fault === "malformed") writeFileSync(file, "PRIVATE_RECORD_CONTENT {")
        else if (fault === "utf8") writeFileSync(file, Buffer.from([0xc0, 0xaf]))
        else if (fault === "at-limit") writeFileSync(file, Buffer.alloc(65536, 32))
        else if (fault === "below-limit") writeFileSync(file, Buffer.alloc(65535, 32))
        else if (fault === "oversized") writeFileSync(file, Buffer.alloc(65537, 32))
        else if (fault === "sparse") truncateSync(file, 1024 * 1024 * 1024)
        else if (fault === "serialized") writeFileSync(file, JSON.stringify(JSON.parse(original), null, 2))
        else {
          const value = JSON.parse(original)
          if (fault === "wrong-version") value.version = 2
          if (fault === "wrong-type") value.runId = 42
          if (fault === "missing-field") delete value.repoRoot
          if (fault === "extra-field") value.extra = "PRIVATE_RECORD_CONTENT"
          if (fault.startsWith("foreign-")) value[fault.slice(8)] = "foreign"
          writeFileSync(file, JSON.stringify(value))
        }
        // Sparse records must never be read by the evidence collector either.
        const stat = lstatSync(file)
        writeFileSync(marker, JSON.stringify({ fault, target: file, mode: stat.mode, size: stat.size }))
      }
      const excluded = new Set([file, file + ".original"])
      const recordBefore = dynamic ? undefined : recordSnapshot(file)
      const backupBefore = existsSync(file + ".original") ? recordSnapshot(file + ".original") : undefined
      const before = { repo: snapshot(f.repo, excluded), workspace: snapshot(saved.worktrees.change.path) }
      const calls = f.records().length
      const originalOptions = f.env.NODE_OPTIONS
      if (dynamic) {
        f.env.NODE_OPTIONS += ` --require=${
          fileURLToPath(new URL("../test/fixtures/ownership-faults.cjs", import.meta.url))
        }`
        Object.assign(f.env, {
          AGENTRUN_RECORD_TARGET: file,
          AGENTRUN_RECORD_FAULT: fault,
          AGENTRUN_RECORD_MARKER: marker,
        })
      }
      f.env.AGENTRUN_REFUSAL = "1"
      const start = Date.now()
      const result = f.exec(process.execPath, [cli, "resume", id, "--json"])
      const elapsedMs = Date.now() - start
      assert.equal(result.error, undefined, "Refusal must exit naturally within10seconds")
      assert.ok(elapsedMs <= 10000, `Refusal took ${elapsedMs}ms`)
      assert.equal(result.signal, null)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /ownership/i)
      assert.ok(!result.stderr.includes("PRIVATE_RECORD_CONTENT"))
      assert.equal(f.records().length, calls)
      assert.equal(existsSync(marker), true, "Injection must have happened")
      assert.deepEqual({ repo: snapshot(f.repo, excluded), workspace: snapshot(saved.worktrees.change.path) }, before)
      const injected = JSON.parse(readFileSync(marker))
      if (!dynamic) assert.deepEqual(recordSnapshot(file), recordBefore)
      if (backupBefore !== undefined) assert.deepEqual(recordSnapshot(file + ".original"), backupBefore)
      else if (dynamic && (fault.includes("replace") || fault === "device-before-open")) {
        assert.deepEqual(readFileSync(file + ".original"), original)
      }
      if (dynamic) {
        assert.deepEqual(recordSnapshot(file), injected.after)
        if (injected.backup !== undefined) assert.deepEqual(recordSnapshot(file + ".original"), injected.backup)
      }
      writeFileSync(
        join(f.directory, "refusal.json"),
        JSON.stringify(
          {
            record,
            fault,
            elapsedMs,
            additionalCalls: f.records().length - calls,
            preserved: true,
            injection: injected,
          },
          null,
          2,
        ),
      )
      f.env.NODE_OPTIONS = originalOptions
      for (
        const key of ["AGENTRUN_REFUSAL", "AGENTRUN_RECORD_TARGET", "AGENTRUN_RECORD_FAULT", "AGENTRUN_RECORD_MARKER"]
      ) delete f.env[key]
      f.command(["run", "TASKS.md", "--run-id", "fresh-0099", "--json"])
      assert.equal(f.state("fresh-0099").status.change._tag, "succeeded")
      assert.equal(f.records().length, calls + 1)
      writeFileSync(
        join(f.directory, "lock-release.json"),
        JSON.stringify({ runId: "fresh-0099", branch: "agentrun/change-0099", result: "passed" }),
      )
    })
  }
}

for (const record of ["reservation", "receipt"]) {
  scenario(`bounded-${record}-short-read`, (f) => {
    const id = "short-0042"
    f.command(["run", "TASKS.md", "--run-id", id, "--keep-worktrees", "--json"])
    const file = record === "reservation"
      ? join(f.repo, ".git/agentrun/ownership/runs", id, "owner.json")
      : join(
        f.repo,
        ".git/agentrun/ownership/branches",
        readdirSync(join(f.repo, ".git/agentrun/ownership/branches"))[0],
      )
    const before = recordSnapshot(file)
    const marker = join(f.directory, "injection.json")
    const originalOptions = f.env.NODE_OPTIONS
    f.env.NODE_OPTIONS += ` --require=${
      fileURLToPath(new URL("../test/fixtures/ownership-faults.cjs", import.meta.url))
    }`
    Object.assign(f.env, {
      AGENTRUN_RECORD_TARGET: file,
      AGENTRUN_RECORD_FAULT: "short-read",
      AGENTRUN_RECORD_MARKER: marker,
    })
    f.command(["resume", id, "--json"])
    assert.equal(existsSync(marker), true)
    assert.deepEqual(recordSnapshot(file), before)
    assert.equal(f.records().length, 1)
    assert.equal(f.state(id).status.change._tag, "succeeded")
    f.env.NODE_OPTIONS = originalOptions
    for (const key of ["AGENTRUN_RECORD_TARGET", "AGENTRUN_RECORD_FAULT", "AGENTRUN_RECORD_MARKER"]) delete f.env[key]
    f.command(["run", "TASKS.md", "--run-id", "fresh-0099", "--json"])
  })
}

if (selected === undefined) assert.deepEqual(outcomes.map((outcome) => outcome.name), declared)
assert.equal(new Set(declared).size, declared.length, "Scenario names must be unique")
if (packageTarget) {
  for (const [file, hash] of Object.entries(packageProof.hashes)) {
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), hash)
  }
  assert.equal(setup("git", ["status", "--porcelain"]), "", "Source changed during installed proof")
  assert.equal(setup("git", ["rev-parse", "HEAD"]), packageProof.head, "Candidate commit changed")
  assert.equal(setup("git", ["branch", "--show-current"]), packageProof.branch, "Candidate branch changed")
  const finalCore = realpathSync(join(evidence, "consumer/node_modules/@agentrun/core"))
  const finalCli = realpathSync(join(evidence, "consumer/node_modules/agentrun"))
  assert.deepEqual(
    {
      core: finalCore,
      cli: finalCli,
      cliCore: realpathSync(join(dirname(finalCli), "@agentrun/core")),
      coreEffect: realpathSync(join(dirname(dirname(finalCore)), "effect")),
      cliEffect: realpathSync(join(dirname(finalCli), "effect")),
    },
    packageProof.bindings,
    "Installed bindings changed",
  )
  writeFileSync(
    join(evidence, "final-proof.json"),
    JSON.stringify(
      {
        head: packageProof.head,
        sourceClean: true,
        hashesUnchanged: true,
        bindingsUnchanged: true,
        scope: selected ?? "all",
        declared,
        outcomes: outcomes.length,
        passed: outcomes.filter((outcome) => outcome.result === "passed").length,
      },
      null,
      2,
    ),
  )
}
assert.ok(outcomes.length > 0, "No scenario selected")
process.exitCode = outcomes.some((outcome) => outcome.result === "failed") ? 1 : 0
