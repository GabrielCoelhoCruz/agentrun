import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

const cli = resolve(process.argv[2])
const root = resolve(process.argv[3])
const selected = process.argv[4] ?? "all"
const fixture = fileURLToPath(new URL("../test/fixtures/", import.meta.url))
const example = fileURLToPath(new URL("../../../examples/factory/notes-ts/", import.meta.url))
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
mkdirSync(root, { recursive: false })
const outcomes = []
const active = new Set()
const waitFor = async (read, description, timeout = 30000) => {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const value = read()
    if (value) return value
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`Timed out: ${description}`)
}
const setup = (name, mode = "happy", changeProfile = () => {}, checkMode) => {
  const directory = join(root, name)
  mkdirSync(directory)
  const repo = join(directory, "repo")
  const home = join(directory, "home")
  cpSync(example, repo, { recursive: true })
  mkdirSync(home)
  const commands = []
  const log = join(directory, "providers.jsonl")
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USER: "fixture",
    TMPDIR: directory,
    XDG_CONFIG_HOME: join(home, "config"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
    NODE_OPTIONS: `--import=${pathToFileURL(join(fixture, "provider-hooks.mjs")).href} --import=${
      pathToFileURL(join(fixture, "crash-hooks.mjs")).href
    }`,
    FACTORY_FIXTURE_LOG: log,
    FACTORY_FIXTURE_MODE: mode,
    FACTORY_FIXTURE_ORIGINAL_CHECKS: join(repo, "checks"),
    FACTORY_FIXTURE_DURABLE: join(fixture, "server-durable.ts"),
    FACTORY_FIXTURE_CRASH_MARKER: join(directory, "crashed"),
    FACTORY_FIXTURE_CHECK_LOG: join(directory, "checks.jsonl"),
    ...(checkMode === undefined ? {} : { FACTORY_FIXTURE_CHECK: checkMode }),
  }
  const saveCommands = () => writeFileSync(join(directory, "commands.json"), JSON.stringify(commands, null, 2))
  const run = (executable, argv, extra = {}) => {
    const result = spawnSync(executable, argv, {
      cwd: repo,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 90000,
    })
    const saved = {
      executable,
      argv,
      cwd: repo,
      code: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }
    commands.push(saved)
    saveCommands()
    return saved
  }
  const git = (...args) => {
    const result = run("git", args)
    assert.equal(result.code, 0, result.stderr)
    return result.stdout.trim()
  }
  const command = (args, code = 0, extra = {}) => {
    const result = run(process.execPath, [cli, ...args, "--json"], extra)
    assert.equal(result.code, code, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`)
    return result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout)
  }
  const launch = (args, extra = {}) => {
    const child = spawn(process.execPath, [cli, ...args, "--json"], {
      cwd: repo,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    })
    active.add(child)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => {
      stdout += String(data)
    })
    child.stderr.on("data", (data) => {
      stderr += String(data)
    })
    const completed = new Promise((done) => {
      child.on("close", (code, signal) => {
        active.delete(child)
        const result = {
          executable: process.execPath,
          argv: [cli, ...args, "--json"],
          cwd: repo,
          pid: child.pid,
          code,
          signal,
          stdout,
          stderr,
        }
        commands.push(result)
        saveCommands()
        done(result)
      })
    })
    return { child, completed }
  }
  const profile = JSON.parse(readFileSync(join(repo, "factory.json"), "utf8"))
  profile.limits.durationMs = 300000
  if (checkMode !== undefined) {
    cpSync(join(fixture, "check-result.mjs"), join(repo, "checks/restart.mjs"))
    profile.checks[0].requiredEnv = ["FACTORY_FIXTURE_CHECK", "FACTORY_FIXTURE_CHECK_LOG"]
  }
  changeProfile(profile, repo)
  writeFileSync(join(repo, "factory.json"), JSON.stringify(profile, null, 2))
  writeFileSync(join(repo, ".gitignore"), ".agentrun/\n")
  git("init", "-q")
  git("config", "commit.gpgsign", "false")
  git("add", ".")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "starter")
  const base = git("rev-parse", "HEAD")
  const id = "notes-001"
  const startArgs = [
    "start",
    "--profile",
    "factory.json",
    "--goal",
    "Store a note and read it after restart",
    "--id",
    id,
  ]
  const records = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
  const stateDirectory = join(repo, ".git/agentrun/factory/runs", id)
  return {
    directory,
    repo,
    home,
    env,
    run,
    git,
    command,
    launch,
    profile,
    base,
    id,
    records,
    stateDirectory,
    start: (code = 0, extra = {}) => command(startArgs, code, extra),
    startAsync: (extra = {}) => launch(startArgs, extra),
    status: () => command(["status", id]),
    events: () => command(["events", id]),
  }
}
const decisionArgs = (context, state, action = "approve") => [
  "decide",
  context.id,
  "--request",
  state.request.id,
  "--candidate",
  state.request.candidate,
  "--evidence",
  state.request.evidenceDigest,
  "--expected-version",
  String(state.request.expectedVersion),
  "--action",
  action,
]
const approve = (context, state) => context.command(decisionArgs(context, state))
const assertHuman = (state) => {
  assert.equal(state.stage, "human")
  assert.ok(state.request.allowedActions.includes("approve"))
  assert.match(state.candidate.commit, /^[a-f0-9]{40,64}$/)
  assert.equal(state.evidence.every((entry) => entry.outcome === "pass"), true)
  assert.equal(state.review.verdict, "accepted")
}
const assertBlocked = (state, reason) => {
  assert.ok(["blocked", "human", "cancelled"].includes(state.stage), JSON.stringify(state))
  assert.match(state.blocker ?? state.request?.reason ?? "", reason)
  assert.equal(state.request?.allowedActions.includes("approve") ?? false, false)
}
const mutateDatabase = (context, operation) => {
  const db = new DatabaseSync(join(context.stateDirectory, "workflow.sqlite"))
  try {
    operation(db)
  } finally {
    db.close()
  }
}
const activeCheck = (context) => {
  const directory = join(context.stateDirectory, "checks")
  if (!existsSync(directory)) return undefined
  for (const attempt of readdirSync(directory)) {
    const file = join(directory, attempt, "active.json")
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
  }
  return undefined
}
const assertExited = (pid) => {
  const probe = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
  assert.ok(probe.status === 1 || probe.stdout.trim().startsWith("Z"), `owned process ${pid} remains`)
}
const scenario = async (name, run) => {
  if (
    selected !== "all" && !selected.split(",").includes(name)
    && !(selected === "quick" && ["invalid", "happy", "correct"].includes(name))
  ) return
  const started = new Date().toISOString()
  try {
    await run()
    outcomes.push({ name, outcome: "pass", started, ended: new Date().toISOString() })
  } catch (error) {
    outcomes.push({
      name,
      outcome: "fail",
      started,
      ended: new Date().toISOString(),
      error: String(error.stack ?? error),
    })
    throw error
  } finally {
    writeFileSync(
      join(root, "results.json"),
      JSON.stringify(
        { cli, cliSha256: existsSync(cli) ? hash(readFileSync(cli)) : null, paidProviderCalls: 0, outcomes },
        null,
        2,
      ),
    )
  }
}

try {
  await scenario("invalid", async () => {
    const invalid = [
      ["unknown", (p) => {
        p.unknown = true
      }],
      ["version", (p) => {
        p.version = 99
      }],
      ["reference", (p) => {
        p.acceptance[0].check = "missing"
      }],
      ["acceptance-missing", (p) => {
        delete p.acceptance
      }],
      ["acceptance-empty", (p) => {
        p.acceptance = []
      }],
      ["unknown-role-field", (p) => {
        p.roles.review.tools = "write"
      }],
      ["cwd-escape", (p) => {
        p.checks[0].cwd = "../other"
      }],
      ["missing-role", (p) => {
        p.roles.review.instructions = "missing.md"
      }],
      ["missing-command", (p) => {
        p.checks[0].argv[0] = "factory-command-that-does-not-exist"
      }],
      ["missing-env", (p) => {
        p.checks[0].requiredEnv = ["FACTORY_REQUIRED_MISSING"]
      }],
      ["unsupported-budget", (p) => {
        p.roles.review.agent = "pi"
        p.limits.providerBudgetUsd = 1
      }],
    ]
    for (const [name, change] of invalid) {
      const context = setup(name, "happy", change)
      context.start(2)
      assert.equal(context.records().length, 0)
      assert.equal(existsSync(context.stateDirectory), false)
      assert.equal(context.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1)
    }
  })
  await scenario("happy", async () => {
    const c = setup("happy")
    const state = c.start()
    assertHuman(state)
    assert.notEqual(state.candidate.commit, c.base)
    c.git("merge-base", "--is-ancestor", c.base, state.candidate.commit)
    assert.equal(c.records().filter((r) => r.kind === "provider").length, 2)
    const resumed = c.command(["resume", c.id])
    assert.equal(resumed.version, state.version)
    assert.equal(c.records().filter((r) => r.kind === "provider").length, 2)
    const approved = approve(c, state)
    assert.equal(approved.stage, "approved")
    assert.deepEqual(approve(c, state), approved)
    const exported = c.command(["export", c.id])
    assert.equal(exported.stage, "exported")
    assert.deepEqual(c.command(["export", c.id]), exported)
    const manifest = JSON.parse(readFileSync(join(exported.export.directory, "manifest.json"), "utf8"))
    assert.equal(manifest.candidate.commit, state.candidate.commit)
    assert.equal(manifest.profileHash, state.candidate.profileHash)
    const unpacked = join(c.directory, "delivered")
    mkdirSync(unpacked)
    const extracted = spawnSync("tar", ["-xf", join(exported.export.directory, "source.tar"), "-C", unpacked])
    assert.equal(extracted.status, 0)
    assert.equal(
      readFileSync(join(unpacked, "server.ts"), "utf8"),
      `${c.git("show", `${state.candidate.commit}:server.ts`)}\n`,
    )
    const artifacts = join(c.directory, "exported-journey")
    mkdirSync(artifacts)
    const result = spawnSync(process.execPath, ["checks/restart.mjs"], {
      cwd: unpacked,
      env: {
        PATH: c.env.PATH,
        HOME: c.home,
        FACTORY_ARTIFACT_DIR: artifacts,
        FACTORY_RESULT: join(artifacts, "result.json"),
        FACTORY_ATTEMPT_ID: "exported-proof",
        FACTORY_CANDIDATE: state.candidate.commit,
        FACTORY_CHECK_ID: "restart",
      },
      encoding: "utf8",
      timeout: 30000,
    })
    writeFileSync(
      join(c.directory, "exported-journey-command.json"),
      JSON.stringify(
        {
          argv: [process.execPath, "checks/restart.mjs"],
          cwd: unpacked,
          code: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        null,
        2,
      ),
    )
    assert.equal(result.status, 0, result.stderr)
    const journey = JSON.parse(readFileSync(join(artifacts, "journey.json"), "utf8"))
    assert.ok(journey.some((entry) => entry.event === "read-after-restart"))
    assert.ok(journey.some((entry) => entry.event === "migration-verified"))
    assert.equal(c.git("status", "--porcelain"), "")
  })
  await scenario("relative-command", async () => {
    const c = setup("relative-command", "happy", (profile, repo) => {
      profile.checks[0].argv = ["checks/run"]
      profile.checks[0].files.push("checks/run")
      writeFileSync(join(repo, "checks/run"), "#!/bin/sh\ncd \"$(dirname \"$0\")/..\"\nexec node checks/restart.mjs\n")
      chmodSync(join(repo, "checks/run"), 0o755)
    })
    assertHuman(c.start())
  })
  await scenario("correct", async () => {
    const c = setup("correct", "correct")
    const state = c.start()
    assertHuman(state)
    const providers = c.records().filter((r) => r.kind === "provider")
    assert.deepEqual(providers.map((r) => r.stage), ["implement", "correct", "review"])
    assert.notEqual(providers[1].inputSha, c.base)
    const events = c.events()
    assert.ok(events.some((event) => event.fact._tag === "CheckRecorded" && event.fact.evidence.outcome === "fail"))
    assert.equal(state.evidence.every((entry) => entry.candidate === state.candidate.commit), true)
  })
  for (
    const mode of [
      "wrong-output",
      "correction-limit",
      "no-change",
      "malformed-review",
      "outside-diff",
      "wrong-review-candidate",
      "changed-review",
      "wrong-ancestry",
      "changed-check",
      "linked-checks",
      "human-review",
    ]
  ) {
    await scenario(mode, async () => {
      const c = setup(mode, mode)
      const state = c.start(1)
      assertBlocked(
        state,
        mode === "no-change" ? /no.change/i : /review|candidate|ancestry|check|correction|producer|human/i,
      )
      assert.ok(c.records().filter((r) => r.stage === "correct").length <= 2)
      c.command(["export", c.id], 1)
    })
  }
  await scenario("review-revision", async () => {
    const c = setup("review-revision", "review-revision")
    assertHuman(c.start())
    assert.deepEqual(c.records().filter((r) => r.kind === "provider").map((r) => r.stage), [
      "implement",
      "review",
      "correct",
      "review",
    ])
  })
  for (
    const mode of [
      "missing-result",
      "wrong-candidate",
      "old-attempt",
      "omitted-criterion",
      "missing-artifact",
      "linked-artifact",
    ]
  ) {
    await scenario(mode, async () => {
      const c = setup(mode, "happy", () => {}, mode)
      const expected = {
        "missing-result": /result is missing/i,
        "wrong-candidate": /wrong candidate/i,
        "old-attempt": /wrong candidate, check, or attempt/i,
        "omitted-criterion": /omitted or repeated an acceptance criterion/i,
        "missing-artifact": /artifact.*ENOENT|regular file/i,
        "linked-artifact": /artifact.*outside/i,
      }
      assertBlocked(c.start(1), expected[mode])
      assert.equal(readFileSync(c.env.FACTORY_FIXTURE_CHECK_LOG, "utf8").trim().split("\n").length, 1)
      assert.equal(c.records().filter((r) => r.stage === "review").length, 0)
    })
  }
  await scenario("stale-approval", async () => {
    const c = setup("stale-approval")
    const original = c.start()
    assertHuman(original)
    const args = decisionArgs(c, original)
    for (const flag of ["--request", "--candidate", "--evidence", "--expected-version"]) {
      const bad = [...args]
      bad[bad.indexOf(flag) + 1] = flag === "--expected-version"
        ? "0"
        : flag === "--request"
        ? "wrong-request"
        : "0".repeat(flag === "--candidate" ? 40 : 64)
      c.command(bad, 1)
      assert.equal(c.status().version, original.version)
    }
    c.command(decisionArgs(c, original, "correct"))
    assertHuman(c.command(["resume", c.id]))
    c.command(args, 1)
    c.command(["export", c.id], 1)
  })
  for (
    const tag of [
      "AttemptPrepared",
      "ProcessRegistered",
      "DispatchReleased",
      "ProcessCompleted",
      "OutputCaptured",
      "AgentRecorded",
      "CheckRecorded",
      "ReviewRecorded",
      "HumanRequested",
      "ExportPrepared",
      "Exported",
    ]
  ) {
    await scenario(`crash-${tag}`, async () => {
      const c = setup(`crash-${tag}`)
      if (tag.startsWith("Export")) {
        const state = c.start()
        approve(c, state)
        const crashed = c.run(process.execPath, [cli, "export", c.id, "--json"], { FACTORY_FIXTURE_CRASH: tag })
        assert.equal(crashed.signal, "SIGKILL", crashed.stderr)
        assert.equal(c.command(["export", c.id]).stage, "exported")
      } else {
        const running = c.startAsync({ FACTORY_FIXTURE_CRASH: tag })
        const crashed = await running.completed
        assert.equal(crashed.signal, "SIGKILL", crashed.stderr)
        const resumed = c.command(["resume", c.id])
        assertHuman(resumed)
        assert.equal(c.records().filter((r) => r.kind === "provider").length, 2)
      }
    })
  }
  await scenario("corrupt-report", async () => {
    const c = setup("corrupt-report")
    const running = c.startAsync({ FACTORY_FIXTURE_CRASH: "ProcessCompleted" })
    assert.equal((await running.completed).signal, "SIGKILL")
    const prepared = c.events().find((e) => e.fact._tag === "AttemptPrepared").fact.attempt
    const report = join(c.repo, ".agentrun/runs", prepared.executorRunId, "report.json")
    const data = JSON.parse(readFileSync(report, "utf8"))
    data.baseSha = "0".repeat(40)
    writeFileSync(report, JSON.stringify(data))
    assertBlocked(c.command(["resume", c.id], 1), /report|identity|state/i)
    assert.equal(c.records().filter((r) => r.kind === "provider").length, 1)
  })
  for (const kind of ["missing", "corrupt", "event-gap", "artifact"]) {
    await scenario(`corrupt-${kind}`, async () => {
      const c = setup(`corrupt-${kind}`)
      const state = c.start()
      approve(c, state)
      const database = join(c.stateDirectory, "workflow.sqlite")
      if (kind === "corrupt") writeFileSync(database, "corrupt data remains\n")
      if (kind === "missing") {
        const destination = join(c.directory, "preserved-workflow.sqlite")
        const { renameSync } = await import("node:fs")
        renameSync(database, destination)
      }
      if (kind === "event-gap") mutateDatabase(c, (db) => db.exec("DELETE FROM facts WHERE seq = 2"))
      if (kind === "artifact") {
        mutateDatabase(
          c,
          (db) => db.exec("UPDATE artifacts SET bytes = X'00' WHERE digest = (SELECT digest FROM artifacts LIMIT 1)"),
        )
      }
      c.command(["resume", c.id], 1)
      c.command(["export", c.id], 1)
      if (kind === "corrupt") assert.equal(readFileSync(database, "utf8"), "corrupt data remains\n")
      assert.equal(c.records().filter((r) => r.kind === "provider").length, 2)
    })
  }
  for (const kind of ["reservation", "state", "receipt"]) {
    await scenario(`executor-missing-${kind}`, async () => {
      const c = setup(`executor-missing-${kind}`)
      const running = c.startAsync({
        FACTORY_FIXTURE_CRASH: kind === "reservation" ? "AttemptPrepared" : "ProcessCompleted",
      })
      assert.equal((await running.completed).signal, "SIGKILL")
      const attempt = c.events().find((e) => e.fact._tag === "AttemptPrepared").fact.attempt
      if (kind === "reservation") {
        mkdirSync(join(c.repo, ".git/agentrun/ownership/runs", attempt.executorRunId.toLowerCase()), {
          recursive: true,
        })
      }
      if (kind === "state") {
        writeFileSync(join(c.repo, ".agentrun/runs", attempt.executorRunId, "state.json"), "invalid state\n")
      }
      if (kind === "receipt") {
        const stateFile = join(c.repo, ".agentrun/runs", attempt.executorRunId, "state.json")
        const state = JSON.parse(readFileSync(stateFile, "utf8"))
        const task = state.tasks[0].id
        const receipt = join(
          c.repo,
          ".git/agentrun/ownership/branches",
          `${hash(Buffer.from(state.worktrees[task].branch.toLowerCase()))}.json`,
        )
        writeFileSync(receipt, "foreign receipt\n")
      }
      assertBlocked(c.command(["resume", c.id], 1), /state|reservation|ownership|receipt/i)
      assert.ok(c.records().filter((r) => r.kind === "provider").length <= 1)
    })
  }
  for (const mode of ["cancel-agent", "cancel-check"]) {
    await scenario(mode, async () => {
      const c = setup(
        mode,
        mode === "cancel-agent" ? mode : "happy",
        () => {},
        mode === "cancel-check" ? mode : undefined,
      )
      const running = c.startAsync()
      await waitFor(() => {
        if (mode === "cancel-agent") return c.records().some((r) => r.kind === "child")
        return activeCheck(c)
      }, mode)
      const check = activeCheck(c)
      const current = c.status()
      c.command(["cancel", c.id, "--expected-version", String(current.version)])
      const result = await running.completed
      assert.equal(result.code, 130, result.stderr)
      assert.equal(c.status().stage, "cancelled")
      const count = c.records().filter((r) => r.kind === "provider").length
      assertBlocked(c.command(["resume", c.id], 1), /cancel|interrupt|unknown/i)
      assert.equal(c.records().filter((r) => r.kind === "provider").length, count)
      for (const record of c.records()) {
        if (record.kind !== "child") continue
        assertExited(record.pid)
      }
      if (check !== undefined) {
        assertExited(check.pid)
        assertExited(check.child)
      }
    })
  }
  await scenario("double-resume", async () => {
    const c = setup("double-resume")
    const running = c.startAsync({ FACTORY_FIXTURE_CRASH: "AttemptPrepared" })
    assert.equal((await running.completed).signal, "SIGKILL")
    const a = c.launch(["resume", c.id])
    const b = c.launch(["resume", c.id])
    const results = await Promise.all([a.completed, b.completed])
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 1])
    assertHuman(c.status())
    assert.equal(c.records().filter((r) => r.kind === "provider").length, 2)
  })
  await scenario("changed-executor", async () => {
    const c = setup("changed-executor")
    const argv = ["--input-type=module", "-e", "console.log(import.meta.resolve('agentrun'))"]
    const cwd = dirname(realpathSync(cli))
    const resolved = spawnSync(process.execPath, argv, { cwd, encoding: "utf8" })
    writeFileSync(
      join(c.directory, "runtime-resolution.json"),
      JSON.stringify(
        {
          executable: process.execPath,
          argv,
          cwd,
          code: resolved.status,
          stdout: resolved.stdout,
          stderr: resolved.stderr,
        },
        null,
        2,
      ),
    )
    assert.equal(resolved.status, 0, resolved.stderr)
    const original = dirname(dirname(fileURLToPath(resolved.stdout.trim())))
    const runtime = join(c.directory, "runtime")
    mkdirSync(runtime)
    cpSync(join(original, "dist"), join(runtime, "dist"), { recursive: true })
    cpSync(join(original, "package.json"), join(runtime, "package.json"))
    const dependencies = existsSync(join(original, "node_modules/@agentrun/core"))
      ? join(original, "node_modules")
      : dirname(original)
    symlinkSync(dependencies, join(runtime, "node_modules"), "dir")
    const index = join(runtime, "dist/index.mjs")
    c.env.FACTORY_FIXTURE_EXECUTOR_INDEX = pathToFileURL(index).href
    const running = c.startAsync({ FACTORY_FIXTURE_CRASH: "AttemptPrepared" })
    assert.equal((await running.completed).signal, "SIGKILL")
    const originalBytes = readFileSync(index)
    writeFileSync(index, Buffer.concat([originalBytes, Buffer.from("\n// fixture runtime revision\n")]))
    writeFileSync(
      join(c.directory, "runtime-change.json"),
      JSON.stringify({ file: index, before: hash(originalBytes), after: hash(readFileSync(index)) }, null, 2),
    )
    const before = c.events().length
    c.command(["resume", c.id], 1)
    c.start(1)
    assert.equal(c.records().length, 0)
    assert.equal(c.events().length, before)
  })
  await scenario("unknown-cost", async () => {
    const c = setup("unknown-cost", "unknown-cost")
    const state = c.start()
    assertHuman(state)
    assert.equal(state.costUsd, null)
  })
  await scenario("time-limit", async () => {
    const c = setup("time-limit", "happy", (p) => {
      p.limits.durationMs = 1
    })
    assertBlocked(c.start(1), /time|duration/i)
    assert.equal(c.records().length, 0)
  })
  await scenario("budget-limit", async () => {
    const c = setup("budget-limit", "unknown-cost", (p) => {
      p.limits.providerBudgetUsd = 1
    })
    assertBlocked(c.start(1), /budget|cost/i)
    assert.equal(c.records().filter((r) => r.kind === "provider").length, 1)
    assert.equal(c.records().find((r) => r.kind === "provider").maxBudgetUsd, 1)
  })
  await scenario("crash-tools", async () => {
    const c = setup("crash-tools", "crash-tools")
    const running = c.startAsync()
    assert.equal((await running.completed).signal, "SIGKILL")
    assertBlocked(c.command(["resume", c.id], 1), /unknown|active|interrupt/i)
    assert.equal(c.records().filter((r) => r.kind === "provider").length, 1)
    const state = c.status()
    c.command(["cancel", c.id, "--expected-version", String(state.version)])
    assert.equal(c.status().stage, "cancelled")
  })
  await scenario("patch-corruption", async () => {
    const c = setup("patch-corruption")
    const running = c.startAsync({ FACTORY_FIXTURE_CRASH: "ProcessCompleted" })
    assert.equal((await running.completed).signal, "SIGKILL")
    const attempt = c.events().find((e) => e.fact._tag === "AttemptPrepared").fact.attempt
    const run = join(c.repo, ".agentrun/runs", attempt.executorRunId)
    const report = JSON.parse(readFileSync(join(run, "report.json"), "utf8"))
    const patch = join(run, "tasks", report.tasks[0].id, "diff.patch")
    writeFileSync(patch, "wrong patch\n")
    assertBlocked(c.command(["resume", c.id], 1), /patch|report|digest/i)
    assert.equal(readFileSync(patch, "utf8"), "wrong patch\n")
    assert.equal(c.records().filter((r) => r.kind === "provider").length, 1)
  })
  await scenario("post-create-git-failure", async () => {
    const c = setup("post-create-git-failure")
    const hooks = join(c.directory, "hooks")
    mkdirSync(hooks)
    const { chmodSync } = await import("node:fs")
    writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n")
    chmodSync(join(hooks, "post-checkout"), 0o755)
    c.git("config", "core.hooksPath", hooks)
    assertBlocked(c.start(1), /git|ownership|receipt|failed/i)
    const before = c.git("show-ref")
    assertBlocked(c.command(["resume", c.id], 1), /git|ownership|receipt|failed/i)
    assert.equal(c.git("show-ref"), before)
    assert.equal(c.records().length, 0)
  })
  await scenario("export-corruption", async () => {
    const c = setup("export-corruption")
    approve(c, c.start())
    const state = c.command(["export", c.id])
    const file = join(state.export.directory, "source.tar")
    writeFileSync(file, "changed export\n")
    c.command(["export", c.id], 1)
    assert.equal(readFileSync(file, "utf8"), "changed export\n")
  })
  await scenario("executor-crash-completed", async () => {
    const c = setup("executor-crash-completed")
    assertHuman(c.start(0, { FACTORY_FIXTURE_CRASH: "executor-completed" }))
    assert.ok(existsSync(c.env.FACTORY_FIXTURE_CRASH_MARKER))
    assert.deepEqual(c.records().filter((r) => r.kind === "provider").map((r) => r.stage), ["implement", "review"])
    for (const record of c.records()) assertExited(record.pid)
  })
  await scenario("crash-check-completed", async () => {
    const c = setup("crash-check-completed", "happy", () => {}, "record")
    const running = c.startAsync({ FACTORY_FIXTURE_CRASH: "ProcessCompleted", FACTORY_FIXTURE_CRASH_KIND: "check" })
    assert.equal((await running.completed).signal, "SIGKILL")
    assertHuman(c.command(["resume", c.id]))
    assert.equal(readFileSync(c.env.FACTORY_FIXTURE_CHECK_LOG, "utf8").trim().split("\n").length, 1)
  })
  await scenario("crash-check", async () => {
    const c = setup("crash-check", "happy", () => {}, "cancel-check")
    const running = c.startAsync()
    const check = await waitFor(() => activeCheck(c), "executed check and its child")
    running.child.kill("SIGKILL")
    assert.equal((await running.completed).signal, "SIGKILL")
    assertBlocked(c.command(["resume", c.id], 1), /check.*active|unknown outcome/i)
    assert.equal(readFileSync(c.env.FACTORY_FIXTURE_CHECK_LOG, "utf8").trim().split("\n").length, 1)
    c.command(["cancel", c.id, "--expected-version", String(c.status().version)])
    assertExited(check.pid)
    assertExited(check.child)
  })
  await scenario("check-timeout", async () => {
    const c = setup("check-timeout", "happy", (p) => {
      p.checks[0].timeoutMs = 500
    }, "timeout")
    assertBlocked(c.start(1), /result is missing|unknown outcome/i)
    const check = activeCheck(c)
    assert.ok(check, "The timed-out check must have actually started")
    assertExited(check.pid)
    assertExited(check.child)
  })
  await scenario("fabricated-result", async () => {
    const c = setup("fabricated-result", "happy", () => {}, "record")
    const running = c.startAsync({ FACTORY_FIXTURE_CRASH: "AttemptPrepared", FACTORY_FIXTURE_CRASH_KIND: "check" })
    assert.equal((await running.completed).signal, "SIGKILL")
    const attempt = c.events().filter((event) => event.fact._tag === "AttemptPrepared").at(-1).fact.attempt
    const directory = join(c.stateDirectory, "checks", attempt.id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({
        version: 1,
        attemptId: attempt.id,
        candidate: attempt.inputSha,
        checkId: "restart",
        criteria: [{ id: "persisted-note", outcome: "pass", artifacts: ["fake.txt"] }],
      }),
    )
    writeFileSync(join(directory, "fake.txt"), "unexecuted evidence\n")
    assertBlocked(c.command(["resume", c.id], 1), /existed before execution/i)
    assert.equal(existsSync(c.env.FACTORY_FIXTURE_CHECK_LOG), false)
    assert.equal(c.records().filter((r) => r.stage === "review").length, 0)
  })
  await scenario("foreign-process", async () => {
    const c = setup("foreign-process")
    const running = c.startAsync({ FACTORY_FIXTURE_CRASH: "ProcessRegistered" })
    assert.equal((await running.completed).signal, "SIGKILL")
    const sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "unrelated-fixture"], {
      detached: true,
      stdio: "ignore",
    })
    const ended = new Promise((done) => sentinel.once("exit", done))
    try {
      mutateDatabase(c, (db) => {
        let previous = ""
        for (const row of db.prepare("SELECT * FROM facts ORDER BY seq").all()) {
          const fact = JSON.parse(row.body)
          if (fact._tag === "ProcessRegistered") fact.process.pid = sentinel.pid
          const body = JSON.stringify(fact)
          const digest = hash(Buffer.from(`${row.seq}\n${row.at}\n${previous}\n${body}`))
          db.prepare("UPDATE facts SET body = ?, digest = ?, previous = ? WHERE seq = ?").run(
            body,
            digest,
            previous,
            row.seq,
          )
          previous = digest
        }
      })
      assertBlocked(c.command(["resume", c.id], 1), /ownership/i)
      assert.equal(sentinel.exitCode, null)
      assert.equal(sentinel.signalCode, null)
    } finally {
      sentinel.kill("SIGTERM")
      await ended
    }
  })
  assert.ok(outcomes.length > 0, `Unknown scenario: ${selected}`)
  console.log(
    JSON.stringify({
      result: "passed",
      scenarios: outcomes.length,
      cli: realpathSync(cli),
      root,
      paidProviderCalls: 0,
    }),
  )
} finally {
  for (const child of active) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT")
  }
}
