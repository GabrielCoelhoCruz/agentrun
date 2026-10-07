import { stopProcessGroup } from "@agentrun/core"
import { Effect } from "effect"
import { spawn, spawnSync } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, test } from "vitest"
import { alive } from "./process-state.js"

const bin = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url))
const fakeBin = fileURLToPath(new URL("./fixtures/dist/entry.mjs", import.meta.url))
const evidence = process.env.AGENTRUN_TEST_EVIDENCE ?? mkdtempSync(join(tmpdir(), "agentrun-cli-evidence-"))
let sequence = 0
const fixture = (tasks = 2, prompt = "success") => {
  const root = join(evidence, `case-${++sequence}`)
  const repo = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(repo, { recursive: true })
  mkdirSync(home)
  git(repo, ["init", "-q"])
  writeFileSync(join(repo, ".gitignore"), ".agentrun/\n")
  writeFileSync(join(repo, "seed"), "base\n")
  git(repo, ["add", "."])
  git(repo, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "base"])
  writeFileSync(
    join(repo, "TASKS.md"),
    Array.from({ length: tasks }, (_, n) => `## task${n}: Task ${n}\n${prompt}\n`).join("\n"),
  )
  const ownership = {
    closed: false,
    children: new Set<ChildProcessWithoutNullStreams>(),
    repos: new Set<string>(),
    incompleteStates: new Set<string>(),
  }
  const f = { root, repo: realpathSync(repo), home, ownership }
  onTestFinished(() => closeFixture(f), 60000)
  return f
}
const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
type Fixture = ReturnType<typeof fixture>
const spawnChild = (f: Fixture, args: string[], env: NodeJS.ProcessEnv) => {
  if (f.ownership.closed) throw new Error("Fixture is closed")
  f.ownership.repos.add(realpathSync(git(f.repo, ["rev-parse", "--show-toplevel"])))
  const p = spawn(process.execPath, args, { cwd: f.repo, env, detached: true })
  f.ownership.children.add(p)
  return p
}
const child = (f: Fixture, args: string[], shipped = false) => {
  const env = { ...process.env, HOME: f.home, TEST_RECORDS: f.root, PATH: `${join(f.root, "bin")}:${process.env.PATH}` }
  if (existsSync(join(f.root, "crash.cjs"))) {
    Object.assign(env, { NODE_OPTIONS: `--require=${join(f.root, "crash.cjs")}` })
  }
  if (args[0] === "doctor") {
    for (const key of Object.keys(env)) {
      if (/(API_KEY|TOKEN|SECRET|CREDENTIAL|AUTH)/i.test(key)) Reflect.deleteProperty(env, key)
    }
    Object.assign(env, { CLAUDE_CONFIG_DIR: join(f.home, "claude"), PI_CODING_AGENT_DIR: join(f.home, "pi") })
  }
  const p = spawnChild(f, [shipped ? bin : fakeBin, ...args], env)
  let stdout = ""
  let stderr = ""
  p.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  p.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const done = new Promise<number | null>((done, reject) => {
    p.on("error", reject)
    p.on("close", (code) => {
      writeFileSync(
        join(f.root, `process-${p.pid}.json`),
        JSON.stringify(
          {
            executable: process.execPath,
            entry: shipped ? bin : fakeBin,
            cwd: f.repo,
            args,
            pid: p.pid,
            code,
            stdout,
            stderr,
          },
          null,
          2,
        ),
      )
      done(code)
    })
  })
  return { p, done, stdout: () => stdout, stderr: () => stderr }
}
const wait = async (predicate: () => boolean, budgetMs = 15000) => {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Condition did not complete within ${budgetMs / 1000} seconds`)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
interface Saved {
  runId: string
  baseSha: string
  status: Record<string, { _tag: string; attempt?: number; reason?: string }>
  worktrees: Record<string, { path: string; branch: string; pgid?: number; processToken?: string }>
}
const statePath = (f: Fixture) => {
  const runs = join(f.repo, ".agentrun/runs")
  return existsSync(runs) ? join(runs, readdirSync(runs).sort().at(-1) ?? "", "state.json") : ""
}
const state = (f: Fixture): Saved => JSON.parse(readFileSync(statePath(f), "utf8"))
const closeFixture = async (f: Fixture) => {
  f.ownership.closed = true
  const errors: unknown[] = []
  for (const p of f.ownership.children) {
    if (p.pid === undefined || p.exitCode !== null || p.signalCode !== null) continue
    try {
      const current = spawnSync("ps", ["-p", String(p.pid), "-o", "pgid=,command="], {
        encoding: "utf8",
        timeout: 5000,
      })
      if (current.status === 1 && current.stdout.trim() === "" && current.stderr.trim() === "") continue
      const match = current.stdout.trim().match(/^(\d+)\s+(.+)$/)
      if (current.status !== 0 || Number(match?.[1]) !== p.pid || match?.[2] !== p.spawnargs.join(" ")) {
        throw new Error(`Fixture child ${p.pid} ownership changed; cleanup refused`)
      }
      try {
        process.kill(-p.pid, "SIGKILL")
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
      await wait(() => p.exitCode !== null || p.signalCode !== null)
    } catch (error) {
      errors.push(error)
    }
  }
  for (const repo of f.ownership.repos) {
    const runs = join(repo, ".agentrun/runs")
    if (!existsSync(runs)) continue
    for (const run of readdirSync(runs)) {
      const file = join(runs, run, "state.json")
      if (!existsSync(file) || f.ownership.incompleteStates.has(file)) continue
      try {
        const saved: Saved = JSON.parse(readFileSync(file, "utf8"))
        for (const worker of Object.values(saved.worktrees)) {
          if (worker.pgid === undefined) continue
          try {
            await Effect.runPromise(stopProcessGroup(worker.pgid, worker.processToken))
          } catch (error) {
            errors.push(error)
          }
        }
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Fixture process cleanup failed")
}
const lockPath = (f: Fixture) => {
  const common = realpathSync(join(f.repo, git(f.repo, ["rev-parse", "--git-common-dir"])))
  return join(f.home, ".agentrun/locks", `${createHash("sha256").update(common).digest("hex").slice(0, 12)}.lock`)
}

test("built public command validates arguments and dry run has no effects", async () => {
  const f = fixture()
  for (const args of [["--help"], ["--version"], ["run", "--help"], ["resume", "--help"], ["doctor", "--help"]]) {
    const c = child(f, args, true)
    expect(await c.done).toBe(0)
    expect(c.stdout().length).toBeGreaterThan(0)
  }
  for (
    const args of [["run", "TASKS.md", "--concurrency", "0"], ["run", "missing.md"], ["resume", "../escape"], [
      "resume",
      "--base",
      "HEAD",
    ], ["wrong"]]
  ) {
    expect(await child(f, args, true).done).toBe(2)
    expect(existsSync(join(f.repo, ".agentrun"))).toBe(false)
  }
  for (const content of ["## bad heading\ntext", "---\nagent: pi\nmaxTurns: 2\n---\n## a: A\ntext"]) {
    writeFileSync(join(f.repo, "bad.md"), content)
    expect(await child(f, ["run", "bad.md", "--dry-run"], true).done).toBe(2)
  }
  const dry = child(f, ["run", "TASKS.md", "--dry-run", "--json"], true)
  expect(await dry.done).toBe(0)
  expect(JSON.parse(dry.stdout())._tag).toBe("DryRun")
  expect(existsSync(join(f.repo, ".agentrun"))).toBe(false)
  expect(existsSync(join(f.home, ".agentrun"))).toBe(false)
}, 60000)

test("real child CLI persists branches, streams JSON live and preserves worktrees", async () => {
  const f = fixture()
  const c = child(f, ["run", "TASKS.md", "--json", "--concurrency", "2", "--keep-worktrees"])
  await wait(() => c.stdout().includes("running"))
  expect(await c.done).toBe(0)
  const saved = state(f)
  expect(Object.values(saved.status).map((s) => s._tag)).toEqual(["succeeded", "succeeded"])
  for (const [id, w] of Object.entries(saved.worktrees)) {
    expect(existsSync(w.path)).toBe(true)
    expect(w.pgid).toBeUndefined()
    expect(git(f.repo, ["show", `${w.branch}:deliverable`])).toBe(id)
  }
  const events = c.stdout().trim().split("\n").map((line) => JSON.parse(line))
  expect(events.at(-1)._tag).toBe("RunFinished")
  expect(existsSync(lockPath(f))).toBe(false)
}, 30000)

test("task failure leaves independent success and retry is explicit", async () => {
  const f = fixture(2)
  writeFileSync(join(f.repo, "TASKS.md"), "## task0: Fail\nfail\n\n## task1: Good\nsuccess\n")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(1)
  expect(state(f).status.task0?.attempt).toBe(1)
  expect(state(f).status.task1?._tag).toBe("succeeded")
  expect(await child(f, ["resume", "--json"]).done).toBe(1)
  expect(state(f).status.task0?.attempt).toBe(1)
  expect(await child(f, ["resume", state(f).runId, "--retry-failed", "--json"]).done).toBe(1)
  expect(state(f).status.task0?.attempt).toBe(2)
  expect(readFileSync(join(f.root, "starts-task1"), "utf8").trim().split("\n")).toHaveLength(1)
}, 30000)

test("Ctrl-C persists two interrupted tasks and stops their marked children", async () => {
  const f = fixture(3, "hold")
  const c = child(f, ["run", "TASKS.md", "--concurrency", "2", "--json"])
  await wait(() => existsSync(join(f.root, "child-task0")) && existsSync(join(f.root, "child-task1")))
  const pids = [0, 1].map((n) => Number(readFileSync(join(f.root, `child-task${n}`), "utf8")))
  c.p.kill("SIGINT")
  expect(await c.done).toBe(130)
  expect(Object.values(state(f).status).map((s) => s._tag)).toEqual(["interrupted", "interrupted", "pending"])
  for (const w of Object.values(state(f).worktrees)) expect(existsSync(w.path)).toBe(true)
  for (const pid of pids) expect(alive(pid)).toBe(false)
  expect(existsSync(lockPath(f))).toBe(false)
}, 30000)

test("SIGKILL then resume stops owned group before starting and keeps identity", async () => {
  const f = fixture(2)
  writeFileSync(join(f.repo, "TASKS.md"), "## task0: First\nsuccess\n\n## task1: Second\ncrash-once\n")
  const c = child(f, ["run", "TASKS.md", "--concurrency", "1", "--json"])
  await wait(() => existsSync(join(f.root, "child-task1")), 30000)
  const before = state(f)
  const pid = Number(readFileSync(join(f.root, "child-task1"), "utf8"))
  expect(before.status.task0?._tag).toBe("succeeded")
  expect(before.status.task1?._tag).toBe("running")
  expect(alive(pid)).toBe(true)
  c.p.kill("SIGKILL")
  await c.done
  expect(alive(pid)).toBe(true)
  const resume = child(f, ["resume", before.runId, "--json"])
  expect(await resume.done).toBe(0)
  expect(alive(pid)).toBe(false)
  const after = state(f)
  expect(after.runId).toBe(before.runId)
  expect(after.baseSha).toBe(before.baseSha)
  expect(after.worktrees.task1?.branch).toBe(before.worktrees.task1?.branch)
  expect(after.worktrees.task1?.path).toBe(before.worktrees.task1?.path)
  expect(readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(readFileSync(join(f.root, "starts-task1"), "utf8").trim().split("\n")).toHaveLength(2)
  expect(readFileSync(join(f.root, "old-child-at-start"), "utf8")).toBe("gone")
  for (const [id, w] of Object.entries(after.worktrees)) {
    expect(git(f.repo, ["show", `${w.branch}:deliverable`])).toBe(id)
  }
}, 40000)

test("second independent process and linked checkout fail before transition", async () => {
  const f = fixture(1, "hold")
  const first = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "child-task0")))
  const second = child(f, ["run", "TASKS.md", "--json"])
  expect(await second.done).toBe(1)
  expect(second.stderr()).toContain("RunLocked")
  const linked = join(f.root, "linked")
  git(f.repo, ["worktree", "add", "--detach", linked])
  writeFileSync(join(linked, "TASKS.md"), "## x: X\nsuccess\n")
  const third = child({ ...f, repo: linked }, ["run", "TASKS.md", "--json"])
  expect(await third.done).toBe(1)
  expect(third.stderr()).toContain("RunLocked")
  first.p.kill("SIGINT")
  expect(await first.done).toBe(130)
}, 30000)

test("settings opt-in changes provider input and warning stays on stderr", async () => {
  for (const optIn of [false, true]) {
    const f = fixture(1)
    const c = child(f, ["run", "TASKS.md", "--json", ...(optIn ? ["--load-project-settings"] : [])])
    expect(await c.done).toBe(0)
    expect(readFileSync(join(f.root, "settings-task0"), "utf8")).toBe(String(optIn))
    expect(c.stderr().includes("project settings")).toBe(optIn)
    for (const line of c.stdout().trim().split("\n")) JSON.parse(line)
  }
}, 30000)

test("doctor exposes SDK versions and honest auth outcomes without prompt", async () => {
  const f = fixture(1)
  const c = child(f, ["doctor", "--json"], true)
  expect(await c.done).toBe(1)
  const report = JSON.parse(c.stdout())
  expect(report.complete).toBe(false)
  expect(report.lock.ok).toBe(true)
  expect(report.runtime.version).toContain("v24.")
  expect(report.providers).toHaveLength(2)
  expect(report.providers[0].auth.status).toBe("missing")
  for (const provider of report.providers) {
    expect(provider.version.length).toBeGreaterThan(0)
    expect(["available", "missing", "unknown"]).toContain(provider.auth.status)
    if (provider.auth.status === "unknown") expect(provider.auth.reason.length).toBeGreaterThan(0)
  }
  expect(existsSync(join(f.repo, ".agentrun"))).toBe(false)
}, 30000)

test("intent crash and missing worktree become failed until explicit retry", async () => {
  const f = fixture(1)
  mkdirSync(join(f.root, "bin"))
  writeFileSync(
    join(f.root, "bin", "git"),
    `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = add ] && [ ! -e "$TEST_RECORDS/intent-stop" ]; then
  echo $$ > "$TEST_RECORDS/intent-stop"
  kill -STOP $$
fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  )
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "intent-stop")))
  const before = state(f)
  expect(before.status.task0?._tag).toBe("running")
  expect(existsSync(before.worktrees.task0?.path ?? "")).toBe(false)
  const gitPid = Number(readFileSync(join(f.root, "intent-stop"), "utf8"))
  c.p.kill("SIGKILL")
  await c.done
  process.kill(gitPid, "SIGKILL")
  await wait(() => !alive(gitPid))
  expect(await child(f, ["resume", "--json"]).done).toBe(1)
  expect(state(f).status.task0?._tag).toBe("failed")
  expect(state(f).status.task0?.attempt).toBe(1)
  expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
  expect(await child(f, ["resume", "--retry-failed", "--json"]).done).toBe(0)
  expect(state(f).status.task0?._tag).toBe("succeeded")
  expect(state(f).worktrees.task0?.branch).toBe(before.worktrees.task0?.branch)
}, 30000)

test("setup background child stays in the recorded worker group and is stopped", async () => {
  const f = fixture(1, "hold")
  writeFileSync(
    join(f.repo, "TASKS.md"),
    `---\nsetup: 'sleep 300 & echo $! > "$TEST_RECORDS/setup-child"'\n---\n## task0: Setup\nhold\n`,
  )
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "child-task0")))
  const pid = Number(readFileSync(join(f.root, "setup-child"), "utf8"))
  expect(alive(pid)).toBe(true)
  c.p.kill("SIGINT")
  expect(await c.done).toBe(130)
  expect(alive(pid)).toBe(false)
}, 30000)

test("unknown stale reclaim guard refuses safely without provider effects", async () => {
  const f = fixture(1)
  mkdirSync(join(f.home, ".agentrun/locks"), { recursive: true })
  writeFileSync(lockPath(f), "2147483647")
  writeFileSync(`${lockPath(f)}.reclaim`, "")
  const c = child(f, ["run", "TASKS.md", "--json"])
  expect(await c.done).toBe(1)
  expect(c.stderr()).toContain("RunLocked")
  expect(existsSync(join(f.repo, ".agentrun"))).toBe(false)
  expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
  expect(readFileSync(lockPath(f), "utf8")).toBe("2147483647")
}, 30000)

test("resume stops a detached child while the owned worker is still its parent", async () => {
  const f = fixture(1, "detached crash-once")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "child-task0")))
  const pid = Number(readFileSync(join(f.root, "child-task0"), "utf8"))
  try {
    c.p.kill("SIGKILL")
    await c.done
    expect(await child(f, ["resume", "--json"]).done).toBe(0)
    expect(readFileSync(join(f.root, "old-child-at-start"), "utf8")).toBe("gone")
    expect(alive(pid)).toBe(false)
  } finally {
    if (alive(pid)) {
      expect(spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout.trim()).toBe(
        "sleep 300",
      )
      process.kill(pid, "SIGKILL")
      await wait(() => !alive(pid))
    }
  }
}, 30000)

test("plain logs expose task progress and frontmatter setup is honored", async () => {
  const f = fixture(1)
  writeFileSync(
    join(f.repo, "TASKS.md"),
    "---\nconcurrency: 1\nsetup: 'echo ready > setup-result'\n---\n## task0: Good\nsuccess\n",
  )
  const c = child(f, ["run", "TASKS.md", "--keep-worktrees"])
  expect(await c.done).toBe(0)
  expect(c.stdout()).toContain("Task task0: running")
  const w = state(f).worktrees.task0
  expect(w).toBeDefined()
  expect(git(f.repo, ["show", `${w?.branch}:setup-result`])).toBe("ready")
}, 30000)

test("JSON argument failure writes diagnostics only to stderr", async () => {
  const f = fixture(1)
  const c = child(f, ["run", "TASKS.md", "--concurrency", "-1", "--json"], true)
  expect(await c.done).toBe(2)
  expect(c.stdout()).toBe("")
  expect(c.stderr()).toContain("concurrency")
}, 30000)

test("Pi worker Bash keeps background children owned after the shell exits", async () => {
  const f = fixture(1, "owned-bash")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "child-task0")))
  const pid = Number(readFileSync(join(f.root, "child-task0"), "utf8"))
  try {
    c.p.kill("SIGKILL")
    await c.done
    expect(await child(f, ["resume", "--json"]).done).toBe(0)
    expect(alive(pid)).toBe(false)
    expect(readFileSync(join(f.root, "old-child-at-start"), "utf8")).toBe("gone")
  } finally {
    if (alive(pid)) {
      expect(spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout.trim()).toBe(
        "sleep 300",
      )
      process.kill(pid, "SIGKILL")
      await wait(() => !alive(pid))
    }
  }
}, 30000)

test("a worker crash becomes a task failure and independent work finishes", async () => {
  const f = fixture(2)
  writeFileSync(join(f.repo, "TASKS.md"), "## task0: Crash\nworker-exit\n\n## task1: Independent\nsuccess\n")
  const c = child(f, ["run", "TASKS.md", "--json", "--concurrency", "1"])
  expect(await c.done).toBe(1)
  expect(state(f).status.task0?._tag).toBe("failed")
  expect(state(f).status.task1?._tag).toBe("succeeded")
  expect(existsSync(lockPath(f))).toBe(false)
}, 30000)

test("setup failure keeps typed details, skips provider and lets independent work finish", async () => {
  const f = fixture(2)
  writeFileSync(
    join(f.repo, "TASKS.md"),
    `---
setup: 'if [ "$(basename "$PWD")" = task0 ]; then echo setup-detail >&2; exit 7; fi'
---
## task0: Setup failure
success

## task1: Independent
success
`,
  )
  const c = child(f, ["run", "TASKS.md", "--json", "--concurrency", "1"])
  expect(await c.done).toBe(1)
  const saved = state(f)
  expect(saved.status.task0?.reason).toMatch(/^SetupError:/)
  expect(saved.status.task0?.reason).toContain("exited 7: setup-detail")
  expect(saved.status.task0?.reason).toContain("task0")
  expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
  expect(saved.status.task1?._tag).toBe("succeeded")
}, 30000)

test("kernel lease survives replacement contention and releases on parent SIGKILL", async () => {
  const f = fixture(1)
  mkdirSync(join(f.home, ".agentrun/locks"), { recursive: true })
  writeFileSync(lockPath(f), "2147483647")
  const leaseBin = fileURLToPath(new URL("./fixtures/dist/lock-entry.mjs", import.meta.url))
  const p = spawnChild(f, [leaseBin], {
    ...process.env,
    HOME: f.home,
    TEST_RECORDS: f.root,
    TEST_STOP_REPLACEMENT: "yes",
  })
  let stdout = ""
  let stderr = ""
  p.stdout.on("data", (x) => {
    stdout += String(x)
  })
  p.stderr.on("data", (x) => {
    stderr += String(x)
  })
  const done = new Promise((resolve) => p.on("close", resolve))
  try {
    await wait(() => existsSync(join(f.root, "replacement-stop")))
    const reclaimPath = `${lockPath(f)}.reclaim`
    const inode = statSync(reclaimPath).ino
    const table = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" }).stdout
    const rows = table.trim().split("\n").map((line) => {
      const [pid, parent, group, ...command] = line.trim().split(/\s+/)
      return { pid: Number(pid), parent: Number(parent), group: Number(group), command: command.join(" ") }
    })
    const leases = rows.filter((row) => row.command.includes(reclaimPath))
    expect(leases).toHaveLength(1)
    const helpers = rows.filter((row) => leases.some((lease) => row.group === lease.group))
    expect(helpers.length).toBeGreaterThanOrEqual(2)
    writeFileSync(join(f.root, "lease-processes.json"), JSON.stringify(helpers, null, 2))
    expect(readFileSync(reclaimPath, "utf8")).toBe("agentrun-reclaim-v1\n")
    const contender = child(f, ["run", "TASKS.md", "--json"])
    expect(await contender.done).toBe(1)
    expect(contender.stderr()).toBe("RunLocked\n")
    expect(contender.stdout()).toBe("")
    expect(readFileSync(lockPath(f), "utf8")).toBe("2147483647")
    p.kill("SIGKILL")
    await done
    await wait(() => helpers.every((helper) => !alive(helper.pid)))
    const resumed = child(f, ["run", "TASKS.md", "--json"])
    expect(await resumed.done).toBe(0)
    expect(statSync(reclaimPath).ino).toBe(inode)
    expect(existsSync(lockPath(f))).toBe(false)
  } finally {
    p.kill("SIGKILL")
    await done
    writeFileSync(join(f.root, "replacement-process.json"), JSON.stringify({ pid: p.pid, stdout, stderr }))
  }
}, 60000)

test("second Ctrl-C forces exit during slow cleanup and recorded ownership can resume", async () => {
  const f = fixture(1, "slow-cleanup crash-once")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "child-task0")))
  const before = state(f)
  const worker = before.worktrees.task0?.pgid
  const pid = Number(readFileSync(join(f.root, "child-task0"), "utf8"))
  try {
    c.p.kill("SIGINT")
    await wait(() => existsSync(join(f.root, "cleanup-started")))
    const start = Date.now()
    c.p.kill("SIGINT")
    expect(await c.done).toBe(130)
    expect(Date.now() - start).toBeLessThan(1500)
    expect(c.stderr()).toContain("Warning: forced exit")
    expect(state(f).worktrees.task0?.pgid).toBe(worker)
    expect(await child(f, ["resume", "--json"]).done).toBe(0)
    expect(alive(pid)).toBe(false)
    expect(readFileSync(join(f.root, "old-child-at-start"), "utf8")).toBe("gone")
  } finally {
    c.p.kill("SIGKILL")
    if (worker !== undefined && alive(worker)) {
      const command = spawnSync("ps", ["-p", String(worker), "-o", "command="], { encoding: "utf8" }).stdout
      if (command.includes(`agentrun-worker-${before.worktrees.task0?.processToken}`)) process.kill(-worker, "SIGKILL")
    }
  }
}, 30000)

for (const [prompt, tag] of [["protocol-error", "AgentProtocolError"], ["sdk-error", "AgentSpawnError"]]) {
  test(`worker preserves ${tag} while independent work finishes`, async () => {
    const f = fixture(2)
    writeFileSync(join(f.repo, "TASKS.md"), `## task0: Error\n${prompt}\n\n## task1: Good\nsuccess\n`)
    const c = child(f, ["run", "TASKS.md", "--json"])
    expect(await c.done).toBe(1)
    expect(state(f).status.task0?.reason).toMatch(new RegExp(`^${tag}:`))
    expect(state(f).status.task1?._tag).toBe("succeeded")
  }, 30000)
}

test("simultaneous stale contenders keep the fresh winner and stable guard", async () => {
  const f = fixture(1, "hold")
  mkdirSync(join(f.home, ".agentrun/locks"), { recursive: true })
  writeFileSync(lockPath(f), "2147483647")
  const first = child(f, ["run", "TASKS.md", "--json"])
  const second = child(f, ["run", "TASKS.md", "--json"])
  let owner: ReturnType<typeof child> | undefined
  try {
    await wait(() => existsSync(join(f.root, "child-task0")))
    const pid = Number(readFileSync(lockPath(f), "utf8"))
    owner = first.p.pid === pid ? first : second
    expect(owner.p.pid).toBe(pid)
    const rejected = owner === first ? second : first
    expect(await rejected.done).toBe(1)
    expect(rejected.stderr()).toContain("RunLocked")
    expect(readFileSync(lockPath(f), "utf8")).toBe(String(pid))
    expect(alive(pid)).toBe(true)
    const inode = statSync(`${lockPath(f)}.reclaim`).ino
    owner.p.kill("SIGINT")
    expect(await owner.done).toBe(130)
    expect(existsSync(lockPath(f))).toBe(false)
    expect(statSync(`${lockPath(f)}.reclaim`).ino).toBe(inode)
  } finally {
    if (owner === undefined) {
      first.p.kill("SIGINT")
      second.p.kill("SIGINT")
      await Promise.all([first.done, second.done])
    }
  }
}, 30000)

test("worker EOF before input exits without setup or provider effects", async () => {
  const f = fixture(1)
  const worker = fileURLToPath(new URL("./fixtures/dist/fake-worker.mjs", import.meta.url))
  const p = spawnChild(f, [worker], { ...process.env, TEST_RECORDS: f.root })
  let stdout = ""
  let stderr = ""
  p.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  p.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const done = new Promise((resolve) => p.on("close", resolve))
  p.stdin.end()
  expect(await done).toBe(0)
  expect(stdout).toBe("")
  expect(existsSync(join(f.root, "starts-repo"))).toBe(false)
  writeFileSync(join(f.root, "worker-eof.json"), JSON.stringify({ pid: p.pid, stdout, stderr }))
}, 15000)

test("doctor injected diagnostics fail for runtime, lock and auth and succeed when complete", () => {
  const f = fixture(1)
  const entry = fileURLToPath(new URL("./fixtures/dist/doctor-entry.mjs", import.meta.url))
  for (const scenario of ["runtime", "lock", "auth", "ready"]) {
    const result = spawnSync(process.execPath, [entry, scenario], { cwd: f.repo, encoding: "utf8" })
    expect(result.status).toBe(scenario === "ready" ? 0 : 1)
    const report = JSON.parse(result.stdout)
    expect(report.complete).toBe(scenario === "ready")
    expect(report.lock.reason).toBe("injected supported diagnostics")
    writeFileSync(
      join(f.root, `doctor-${scenario}.json`),
      JSON.stringify({ command: [entry, scenario], code: result.status, stdout: result.stdout, stderr: result.stderr }),
    )
  }
}, 30000)

const artifacts = (f: Fixture) => join(f.repo, ".agentrun/runs", state(f).runId)
const reportJson = (f: Fixture) => JSON.parse(readFileSync(join(artifacts(f), "report.json"), "utf8"))
test("durable report includes edits, new files, final text, events and reprints through shipped CLI", async () => {
  const f = fixture(1, "report-edit")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  const dir = artifacts(f)
  const patch = readFileSync(join(dir, "tasks/task0/diff.patch"), "utf8")
  expect(patch).toContain("+edited")
  expect(patch).toContain("+task0")
  const events = readFileSync(join(dir, "tasks/task0/events.jsonl"), "utf8").trim().split("\n").map((line) =>
    JSON.parse(line)
  )
  expect(events.map((e) => e._tag)).toEqual(["Started", "Completed"])
  const report = reportJson(f)
  expect(report.taskReports.task0.result).toBe("done | <script> & **bold**\n# title")
  expect(report.taskReports.task0.diffStat).toEqual({ files: 2, additions: 2, deletions: 1 })
  expect(report.taskReports.task0.durationMs).toBeGreaterThan(0)
  expect(JSON.stringify(report)).not.toContain("processToken")
  const md = readFileSync(join(dir, "report.md"), "utf8")
  expect(md).toContain("&lt;script&gt;")
  expect(md).toContain("\\*\\*bold\\*\\*")
  const printed = child(f, ["report", "--json"], true)
  expect(await printed.done).toBe(0)
  expect(JSON.parse(printed.stdout())).toEqual(report)
  const markdown = child(f, ["report", state(f).runId], true)
  expect(await markdown.done).toBe(0)
  expect(markdown.stdout().trim()).toBe(md.trim())
  const before = readFileSync(join(dir, "tasks/task0/events.jsonl"), "utf8")
  expect(await child(f, ["resume", "--json"]).done).toBe(0)
  expect(readFileSync(join(dir, "tasks/task0/events.jsonl"), "utf8")).toBe(before)
  expect(reportJson(f).taskReports.task0).toEqual(report.taskReports.task0)
}, 30000)

test("no-change success saves an empty patch and reports unsupported cost as n/a", async () => {
  const f = fixture(1, "report-nochange")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  expect(readFileSync(join(artifacts(f), "tasks/task0/diff.patch"), "utf8")).toBe("")
  expect(reportJson(f).taskReports.task0.diffStat.files).toBe(0)
  expect(reportJson(f).taskReports.task0.patchSha256).toBe(createHash("sha256").update("").digest("hex"))
  expect(await child(f, ["report", "--json"], true).done).toBe(0)
  expect(readFileSync(join(artifacts(f), "report.md"), "utf8")).toContain("n/a")
}, 30000)

test("failed reports retain reason and append events on explicit retry", async () => {
  const f = fixture(1, "fail")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(1)
  expect(reportJson(f).status.task0.reason).toContain("injected failure")
  const events = join(artifacts(f), "tasks/task0/events.jsonl")
  const before = readFileSync(events, "utf8")
  expect(await child(f, ["resume", "--retry-failed", "--json"]).done).toBe(1)
  expect(readFileSync(events, "utf8")).toBe(before + before)
}, 30000)

test("interrupted report has duration and no success claim", async () => {
  const f = fixture(1, "hold")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "child-task0")))
  c.p.kill("SIGINT")
  expect(await c.done).toBe(130)
  expect(reportJson(f).status.task0._tag).toBe("interrupted")
  expect(reportJson(f).taskReports.task0.durationMs).toBeGreaterThan(0)
}, 30000)

test("missing and corrupt report return typed errors without provider calls", async () => {
  const f = fixture(1)
  expect(await child(f, ["report", "missing", "--json"], true).done).toBe(2)
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  writeFileSync(join(artifacts(f), "report.json"), "{broken")
  const c = child(f, ["report", "--json"], true)
  expect(await c.done).toBe(2)
  expect(c.stderr()).toContain("ReportError")
  expect(c.stderr()).toContain("report.json")
  expect(readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")).toHaveLength(1)
}, 30000)

test("artifact write failure exits without success; resume completes checkpoint without provider replay", async () => {
  const f = fixture(1, "report-block")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "report-ready")))
  const dir = artifacts(f)
  mkdirSync(join(dir, "tasks/task0/diff.patch"), { recursive: true })
  writeFileSync(join(f.root, "report-go"), "go")
  expect(await c.done).toBe(1)
  expect(c.stderr()).toContain("ReportError")
  expect(state(f).status.task0?._tag).not.toBe("succeeded")
  const { rmdirSync } = await import("node:fs")
  rmdirSync(join(dir, "tasks/task0/diff.patch"))
  expect(await child(f, ["resume", "--json"]).done).toBe(0)
  expect(reportJson(f).status.task0._tag).toBe("succeeded")
  expect(readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")).toHaveLength(1)
}, 30000)

test("legacy success recovers branch patch without replay and states unavailable text", async () => {
  const f = fixture(1)
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
  delete saved.taskReports
  writeFileSync(statePath(f), JSON.stringify(saved))
  expect(await child(f, ["resume", "--json"]).done).toBe(0)
  expect(readFileSync(join(artifacts(f), "tasks/task0/diff.patch"), "utf8")).toContain("+task0")
  expect(readFileSync(join(artifacts(f), "report.md"), "utf8")).toContain("unavailable")
  expect(readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")).toHaveLength(1)
}, 30000)

for (const window of ["commit", "artifacts"]) {
  test(`resume reconciles crash after ${window} without another provider call`, async () => {
    const f = fixture(1)
    if (window === "commit") {
      mkdirSync(join(f.root, "bin"))
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
      writeFileSync(
        join(f.root, "bin/git"),
        `#!${process.execPath}\n`
          + `const {spawnSync}=require('node:child_process'); const fs=require('node:fs');\n`
          + `const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});\n`
          + `if(process.argv.includes('update-ref') && !fs.existsSync(${
            JSON.stringify(join(f.root, "crashed"))
          })){fs.writeFileSync(${
            JSON.stringify(join(f.root, "crashed"))
          },'committed');process.kill(Number(spawnSync('ps',['-p',String(process.ppid),'-o','ppid='],{encoding:'utf8'}).stdout.trim()),'SIGKILL')}\nprocess.exit(r.status ?? 1)\n`,
        { mode: 0o700 },
      )
      expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(null)
      expect(state(f).status.task0?._tag).toBe("running")
    } else {
      expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
      const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
      saved.status.task0 = { _tag: "running", attempt: 1, startedAt: new Date().toISOString() }
      writeFileSync(statePath(f), JSON.stringify(saved))
    }
    const before = readFileSync(join(artifacts(f), "tasks/task0/events.jsonl"), "utf8")
    expect(await child(f, ["resume", "--json"]).done).toBe(0)
    expect(readFileSync(join(artifacts(f), "tasks/task0/events.jsonl"), "utf8")).toBe(before)
    expect(readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")).toHaveLength(1)
    expect(reportJson(f).taskReports.task0.result).toBe("done")
    expect(reportJson(f).status.task0._tag).toBe("succeeded")
    expect(existsSync(state(f).worktrees.task0!.path)).toBe(false)
  }, 30000)
}

test("Completed append failure retains final event for recovery without a provider replay", async () => {
  const f = fixture(1, "report-block")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "report-ready")))
  const target = join(artifacts(f), "tasks/task0/events.jsonl")
  const { renameSync, rmdirSync } = await import("node:fs")
  renameSync(target, `${target}.retained`)
  mkdirSync(target)
  writeFileSync(join(f.root, "report-go"), "go")
  expect(await c.done).toBe(1)
  expect(c.stderr()).toContain("ReportError")
  rmdirSync(target)
  renameSync(`${target}.retained`, target)
  expect(await child(f, ["resume", "--json"]).done).toBe(0)
  expect(readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(readFileSync(target, "utf8").trim().split("\n").map((line) => JSON.parse(line)._tag)).toEqual([
    "Started",
    "Completed",
  ])
}, 30000)

test("report replacement failure leaves a durable completion and exits without hanging", async () => {
  const f = fixture(1, "report-block")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => existsSync(join(f.root, "report-ready")))
  const target = join(artifacts(f), "report.json")
  const { renameSync, rmdirSync } = await import("node:fs")
  renameSync(target, `${target}.retained`)
  mkdirSync(target)
  writeFileSync(join(f.root, "report-go"), "go")
  expect(await c.done).toBe(1)
  expect(c.stderr()).toContain("ReportError")
  expect(state(f).status.task0?._tag).toBe("running")
  expect(git(f.repo, ["show", `${state(f).worktrees.task0!.branch}:deliverable`])).toBe("task0")
  rmdirSync(target)
  renameSync(`${target}.retained`, target)
  const resumed = child(f, ["resume", "--json"])
  expect(await resumed.done).toBe(0)
  expect(resumed.stdout()).not.toContain("TaskDeliverable")
  expect(readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(reportJson(f).status.task0._tag).toBe("succeeded")
}, 30000)

test("diff statistics count content that resembles patch headers", async () => {
  const f = fixture(1, "report-edit-header")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  expect(reportJson(f).taskReports.task0.diffStat).toEqual({ files: 2, additions: 3, deletions: 1 })
}, 30000)

const starts = (f: Fixture) => readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n").length
const advanceBranch = (f: Fixture) => {
  const branch = state(f).worktrees.task0!.branch
  git(f.repo, ["checkout", branch])
  writeFileSync(join(f.repo, "later-user-file"), "later user change\n")
  git(f.repo, ["add", "later-user-file"])
  git(f.repo, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "User change"])
}
for (const window of ["succeeded", "delivered", "missing"]) {
  test(`delivered bytes remain original after branch advance (${window})`, async () => {
    const f = fixture(1, "report-edit")
    expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
    const target = join(artifacts(f), "tasks/task0/diff.patch")
    const before = readFileSync(target)
    const metadata = reportJson(f).taskReports.task0
    if (window === "delivered") {
      const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
      saved.status.task0 = { _tag: "running", attempt: 1, startedAt: new Date().toISOString() }
      writeFileSync(statePath(f), JSON.stringify(saved))
    }
    advanceBranch(f)
    if (window === "missing") (await import("node:fs")).unlinkSync(target)
    expect(await child(f, ["resume", "--json"]).done).toBe(0)
    expect(readFileSync(target)).toEqual(before)
    expect(reportJson(f).taskReports.task0).toEqual(metadata)
    expect(starts(f)).toBe(1)
  }, 30000)
}

test("Git text and binary patches retain exact bytes and apply exact committed files", async () => {
  const f = fixture(1, "report-bytes")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  const saved = state(f)
  const branch = saved.worktrees.task0!.branch
  const patch = readFileSync(join(artifacts(f), "tasks/task0/diff.patch"))
  const direct = spawnSync("git", ["diff", "--binary", `${saved.baseSha}..${branch}`], { cwd: f.repo })
  expect(direct.status).toBe(0)
  expect(patch).toEqual(direct.stdout)
  expect(patch.includes(Buffer.from([0xe9]))).toBe(true)
  expect(patch.toString("utf8")).toContain("GIT binary patch")
  const applyDir = join(f.root, "apply")
  git(f.repo, ["worktree", "add", "--detach", applyDir, saved.baseSha])
  const applied = spawnSync("git", ["apply", "--binary", "-"], { cwd: applyDir, input: patch })
  expect(applied.status).toBe(0)
  for (const file of ["latin.txt", "binary.dat"]) {
    const expected = spawnSync("git", ["show", `${branch}:${file}`], { cwd: f.repo })
    expect(expected.status).toBe(0)
    expect(readFileSync(join(applyDir, file))).toEqual(expected.stdout)
  }
  git(f.repo, ["worktree", "remove", "--force", applyDir])
}, 30000)

for (const damage of ["directory", "changed", "truncated", "unreadable"]) {
  test(`report and resume reject ${damage} patch without replacing it`, async () => {
    const f = fixture(1, "report-edit")
    expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
    const target = join(artifacts(f), "tasks/task0/diff.patch")
    if (damage === "directory") {
      ;(await import("node:fs")).renameSync(target, `${target}.retained`)
      mkdirSync(target)
    } else if (damage === "unreadable") (await import("node:fs")).chmodSync(target, 0)
    else writeFileSync(target, damage === "changed" ? "modified bytes" : "")
    const printed = child(f, ["report", "--json"], true)
    expect(await printed.done).toBe(2)
    expect(printed.stderr()).toContain("ReportError")
    const resumed = child(f, ["resume", "--json"])
    expect(await resumed.done).toBe(1)
    expect(resumed.stderr()).toContain("ReportError")
    if (damage === "directory") expect(statSync(target).isDirectory()).toBe(true)
    else if (damage === "unreadable") (await import("node:fs")).chmodSync(target, 0o600)
    else expect(readFileSync(target, "utf8")).toBe(damage === "changed" ? "modified bytes" : "")
    expect(starts(f)).toBe(1)
  }, 30000)
}

test("missing legacy patch refuses mutable branch reconstruction", async () => {
  const f = fixture(1)
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
  delete saved.taskReports.task0.deliveryCommit
  delete saved.taskReports.task0.patchSha256
  writeFileSync(statePath(f), JSON.stringify(saved))
  advanceBranch(f)
  const target = join(artifacts(f), "tasks/task0/diff.patch")
  ;(await import("node:fs")).unlinkSync(target)
  const resumed = child(f, ["resume", "--json"])
  expect(await resumed.done).toBe(1)
  expect(resumed.stderr()).toContain("ReportError")
  expect(existsSync(target)).toBe(false)
  expect(starts(f)).toBe(1)
}, 30000)

const crashAfterFailed = (f: Fixture) => {
  writeFileSync(
    join(f.root, "crash.cjs"),
    `
const fs = require('node:fs');
const {syncBuiltinESMExports} = require('node:module');
const original = fs.writeFile;
fs.writeFile = function(target, data, ...args) {
  const callback = args.pop();
  return original.call(this, target, data, ...args, (error) => {
    if (!error && String(target).endsWith('/events.jsonl') && Buffer.from(data).toString('utf8').includes('"_tag":"Failed"') && !fs.existsSync(${
      JSON.stringify(join(f.root, "failed-crash"))
    })) {
      fs.writeFileSync(${JSON.stringify(join(f.root, "failed-crash"))}, 'durable Failed');
      process.kill(process.pid, 'SIGKILL');
    }
    callback(error);
  });
};
syncBuiltinESMExports();
`,
  )
}
test("durable Failed crash requires explicit retry and preserves reason", async () => {
  const f = fixture(1, "fail")
  crashAfterFailed(f)
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(null)
  expect(existsSync(join(f.root, "failed-crash"))).toBe(true)
  expect(state(f).status.task0?._tag).toBe("running")
  const events = join(artifacts(f), "tasks/task0/events.jsonl")
  const before = readFileSync(events, "utf8")
  expect(before).toContain("\"_tag\":\"Failed\"")
  expect(await child(f, ["resume", "--json"]).done).toBe(1)
  expect(state(f).status.task0?.reason).toBe("AgentTaskFailed: injected failure")
  expect(starts(f)).toBe(1)
  expect(readFileSync(events, "utf8")).toBe(before)
  expect(await child(f, ["resume", "--retry-failed", "--json"]).done).toBe(1)
  expect(starts(f)).toBe(2)
}, 30000)

test("retry killed before new events does not recover an earlier Failed", async () => {
  const f = fixture(1, "fail")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(1)
  mkdirSync(join(f.root, "bin"))
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  writeFileSync(
    join(f.root, "bin/git"),
    `#!${process.execPath}
const {spawnSync}=require('node:child_process'); const fs=require('node:fs');
const args=process.argv.slice(2);
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(r.status===0 && args[0]==='worktree' && args[1]==='add' && !fs.existsSync(${
      JSON.stringify(join(f.root, "retry-crash"))
    })) {
 fs.writeFileSync(${
      JSON.stringify(join(f.root, "retry-crash"))
    },'acquired before events'); process.kill(Number(spawnSync('ps',['-p',String(process.ppid),'-o','ppid='],{encoding:'utf8'}).stdout.trim()),'SIGKILL');
}
process.exit(r.status ?? 1);
`,
    { mode: 0o700 },
  )
  expect(await child(f, ["resume", "--retry-failed", "--json"]).done).toBe(null)
  expect(state(f).status.task0?.attempt).toBe(2)
  expect(starts(f)).toBe(1)
  expect(await child(f, ["resume", "--json"]).done).toBe(1)
  expect(starts(f)).toBe(2)
  expect(state(f).status.task0?.attempt).toBe(3)
}, 30000)

test("resume publishes the recorded commit after a crash before branch update", async () => {
  const f = fixture(1)
  mkdirSync(join(f.root, "bin"))
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  writeFileSync(
    join(f.root, "bin/git"),
    `#!${process.execPath}
const {spawnSync}=require('node:child_process'); const fs=require('node:fs');
if(process.argv.includes('update-ref') && !fs.existsSync(${JSON.stringify(join(f.root, "prepared-crash"))})) {
 fs.writeFileSync(${
      JSON.stringify(join(f.root, "prepared-crash"))
    },'before publish'); process.kill(Number(spawnSync('ps',['-p',String(process.ppid),'-o','ppid='],{encoding:'utf8'}).stdout.trim()),'SIGKILL'); process.exit(1);
}
const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'}); process.exit(r.status ?? 1);
`,
    { mode: 0o700 },
  )
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(null)
  const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
  expect(saved.taskReports.task0.deliveryCommit).toMatch(/^[a-f0-9]{40}$/)
  expect(git(f.repo, ["rev-parse", saved.worktrees.task0.branch])).toBe(saved.baseSha)
  expect(await child(f, ["resume", "--json"]).done).toBe(0)
  expect(git(f.repo, ["rev-parse", saved.worktrees.task0.branch])).toBe(saved.taskReports.task0.deliveryCommit)
  expect(starts(f)).toBe(1)
}, 30000)

for (const recoveredStatus of ["running", "interrupted"]) {
  test(`durable Failed recovers ${recoveredStatus} legacy checkpoint without provider replay`, async () => {
    const f = fixture(1, "fail")
    crashAfterFailed(f)
    expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(null)
    const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
    saved.taskReports.task0.phase = "unfinished"
    delete saved.taskReports.task0.pendingEvent
    delete saved.taskReports.task0.failureReason
    if (recoveredStatus === "interrupted") saved.status.task0 = { _tag: "interrupted", attempt: 1 }
    writeFileSync(statePath(f), JSON.stringify(saved))
    const events = join(artifacts(f), "tasks/task0/events.jsonl")
    const before = readFileSync(events)
    expect(await child(f, ["resume", "--json"]).done).toBe(1)
    expect(state(f).status.task0?.reason).toBe("AgentTaskFailed: injected failure")
    expect(starts(f)).toBe(1)
    expect(readFileSync(events)).toEqual(before)
  }, 30000)
}

test("legacy retry without an event boundary refuses ambiguous older failure", async () => {
  const f = fixture(1, "fail")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(1)
  const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
  saved.status.task0 = { _tag: "running", attempt: 2, startedAt: new Date().toISOString() }
  saved.taskReports.task0 = { phase: "unfinished" }
  writeFileSync(statePath(f), JSON.stringify(saved))
  git(f.repo, ["worktree", "add", saved.worktrees.task0.path, saved.worktrees.task0.branch])
  const resumed = child(f, ["resume", "--json"])
  expect(await resumed.done).toBe(1)
  expect(resumed.stderr()).toContain("ReportError")
  expect(state(f).status.task0?._tag).toBe("running")
  expect(starts(f)).toBe(1)
}, 30000)

if (process.env.AGENTRUN_CLEANUP_CASE) {
  const scenario = process.env.AGENTRUN_CLEANUP_CASE
  let late: Promise<void> | undefined
  test("fixture cleanup probe", async () => {
    const f = fixture(1, "hold")
    let active = f
    if (scenario === "linked") {
      const linked = join(f.root, "linked")
      git(f.repo, ["worktree", "add", "--detach", linked])
      writeFileSync(join(linked, "TASKS.md"), "## task0: Linked\nhold\n")
      active = { ...f, repo: linked }
    }
    if (scenario === "nested") {
      const nested = join(f.repo, "nested")
      mkdirSync(nested)
      writeFileSync(join(nested, "TASKS.md"), "## task0: Nested\nhold\n")
      active = { ...f, repo: nested }
    }
    child(active, ["run", "TASKS.md", "--json"])
    await wait(() => existsSync(join(f.root, "child-task0")))
    writeFileSync(join(f.root, "probe-ready.json"), JSON.stringify(state(scenario === "nested" ? f : active)))
    if (["assertion", "linked", "nested"].includes(scenario)) expect("injected assertion failure").toBe("success")
    if (scenario === "timeout") {
      late = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 11000))
        let result = "spawned"
        try {
          await child({ ...f }, ["run", "TASKS.md", "--json"]).done
        } catch (error) {
          result = String(error)
        }
        writeFileSync(join(f.root, "late-result"), result)
      })()
      await late
    }
    if (scenario === "unknown" || scenario === "reused") {
      const saved = state(f)
      saved.worktrees.foreign = {
        path: "unrelated",
        branch: "unrelated",
        pgid: Number(process.env.AGENTRUN_FOREIGN_PID),
        ...(scenario === "reused" ? { processToken: "0".repeat(32) } : {}),
      }
      writeFileSync(statePath(f), JSON.stringify(saved))
    }
  }, 10000)
  if (scenario === "timeout") {
    test("fixture cleanup probe waits for late continuation", async () => {
      await late
      expect(readFileSync(join(evidence, "case-1/late-result"), "utf8")).toContain("closed")
    }, 15000)
  }
}

const startsCount = (f: Fixture) => readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n").length
const timedFixture = (prompt: string, stall = "2 seconds", max = "10 seconds", setup?: string) => {
  const f = fixture(1, prompt)
  writeFileSync(
    join(f.repo, "TASKS.md"),
    `---\nstallTimeout: ${stall}\nmaxDuration: ${max}\n${
      setup ? `setup: ${setup}\n` : ""
    }---\n## task0: Timed\n${prompt}\n`,
  )
  return f
}

for (const prompt of ["retry-success", "retry-exhaust"]) {
  test(`CLI ${prompt} saves retry events, costs and terminal failure without automatic resume`, async () => {
    const f = timedFixture(prompt)
    const c = child(f, ["run", "TASKS.md", "--json"])
    expect(await c.done).toBe(prompt === "retry-success" ? 0 : 1)
    expect(startsCount(f)).toBe(3)
    if (prompt === "retry-exhaust") expect(state(f).status.task0?.reason).toMatch(/^AgentCrashed:/)
    const events = readFileSync(join(artifacts(f), "tasks/task0/events.jsonl"), "utf8").trim().split("\n").map((line) =>
      JSON.parse(line)
    )
    expect(events.filter((e) => e._tag === "Retry").map((e) => e.attempt)).toEqual([2, 3])
    expect(reportJson(f).taskReports.task0.costUsd).toBeCloseTo(0.6)
    expect(c.stdout().trim().split("\n").at(-1)).toContain("RunFinished")
    expect(await child(f, ["resume", "--json"]).done).toBe(prompt === "retry-success" ? 0 : 1)
    expect(startsCount(f)).toBe(3)
    expect(existsSync(lockPath(f))).toBe(false)
  }, 30000)
}

test("CLI Ctrl-C during retry backoff stays interrupted and exits 130", async () => {
  const f = timedFixture("retry-exhaust")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => c.stdout().includes("\"_tag\":\"Retry\""))
  c.p.kill("SIGINT")
  expect(await c.done).toBe(130)
  expect(startsCount(f)).toBe(1)
  expect(state(f).status.task0?._tag).toBe("interrupted")
  expect(existsSync(lockPath(f))).toBe(false)
}, 30000)

for (const mode of ["stall", "ceiling", "setup", "partial"] as const) {
  test(`CLI ${mode} cleans owned processes and retains only partial work across resume`, async () => {
    const f = timedFixture(
      mode === "stall"
        ? "hold"
        : mode === "ceiling"
        ? "deadline-active"
        : mode === "partial"
        ? "partial-crash"
        : "success",
      "2 seconds",
      mode === "setup" ? "1500 millis" : mode === "stall" ? "10 seconds" : "5 seconds",
      mode === "setup" ? "sleep 300" : undefined,
    )
    const c = child(f, ["run", "TASKS.md", "--json"])
    expect(await c.done).toBe(1)
    const saved = state(f)
    expect(saved.status.task0?.reason).toMatch(
      mode === "stall" ? /^AgentStalled:/ : mode === "partial" ? /^AgentCrashed:/ : /^AgentTimedOut:/,
    )
    const kept = mode === "ceiling" || mode === "partial"
    expect(existsSync(saved.worktrees.task0!.path)).toBe(kept)
    if (mode === "stall") {
      expect(alive(Number(readFileSync(join(f.root, "child-task0"), "utf8")))).toBe(false)
    }
    if (mode !== "setup") {
      for (const pid of readFileSync(join(f.root, "starts-task0"), "utf8").trim().split("\n")) {
        expect(alive(Number(pid))).toBe(false)
      }
      expect(startsCount(f)).toBe(1)
    }
    expect(reportJson(f).status.task0?._tag).toBe("failed")
    expect(await child(f, ["resume", "--json"]).done).toBe(1)
    expect(existsSync(saved.worktrees.task0!.path)).toBe(kept)
    expect(existsSync(lockPath(f))).toBe(false)
  }, 30000)
}

test("CLI crash at runner retry boundary resumes without assigning an old failure", async () => {
  const f = timedFixture("retry-success", "5 minutes", "60 minutes")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => c.stdout().includes("\"_tag\":\"Retry\""))
  const events: import("@agentrun/core").AgentEvent[] = readFileSync(
    join(artifacts(f), "tasks/task0/events.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line))
  expect(events.filter((event) => event._tag === "Retry")).toEqual([
    { _tag: "Retry", source: "runner", attempt: 2, reason: expect.stringMatching(/^AgentCrashed:/) },
  ])
  expect(startsCount(f)).toBe(1)
  c.p.kill("SIGKILL")
  await c.done
  expect(state(f).status.task0?._tag).toBe("running")
  expect(await child(f, ["resume", "--json"]).done).toBe(0)
  expect(startsCount(f)).toBe(3)
  expect(state(f).status.task0?._tag).toBe("succeeded")
  expect(reportJson(f).taskReports.task0.costUsd).toBeCloseTo(0.6)
}, 30000)

test("CLI retries do not rerun successful setup", async () => {
  const f = timedFixture("retry-success", "5 minutes", "60 minutes", "echo setup >> \"$TEST_RECORDS/setup-count\"")
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(0)
  const events: import("@agentrun/core").AgentEvent[] = readFileSync(
    join(artifacts(f), "tasks/task0/events.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line))
  expect(events.filter((event) => event._tag === "Retry")).toEqual([
    { _tag: "Retry", source: "runner", attempt: 2, reason: expect.stringMatching(/^AgentCrashed:/) },
    { _tag: "Retry", source: "runner", attempt: 3, reason: expect.stringMatching(/^AgentCrashed:/) },
  ])
  expect(state(f).status.task0?._tag).toBe("succeeded")
  expect(startsCount(f)).toBe(3)
  expect(readFileSync(join(f.root, "setup-count"), "utf8").trim().split("\n")).toHaveLength(1)
}, 30000)

test("worker registration storage failure launches only one worker and no provider", async () => {
  const f = fixture(1, "success")
  writeFileSync(
    join(f.root, "crash.cjs"),
    `
const fs = require('node:fs');
const cp = require('node:child_process');
const originalSpawn = cp.spawn;
cp.spawn = function(command, args, options) {
  const p = originalSpawn.call(this, command, args, options);
  if (args && args.some(a => String(a).startsWith('agentrun-worker-'))) {
    fs.appendFileSync(${JSON.stringify(join(f.root, "worker-launches"))}, p.pid + '\\n');
  }
  return p;
};
const originalWrite = fs.writeFile;
fs.writeFile = function(target, data, ...rest) {
  if (String(target).endsWith('/state.json.tmp') && Buffer.from(data).toString('utf8').includes('"pgid"') && !fs.existsSync(${
      JSON.stringify(join(f.root, "storage-failed"))
    })) {
    fs.writeFileSync(${JSON.stringify(join(f.root, "storage-failed"))}, 'one registration failure');
    const callback = rest.at(-1);
    process.nextTick(() => callback(Object.assign(new Error('injected storage failure'), {code:'EIO'})));
    return;
  }
  return originalWrite.call(this, target, data, ...rest);
};
`,
  )
  const c = child(f, ["run", "TASKS.md", "--json"])
  expect(await c.done).toBe(1)
  expect(existsSync(join(f.root, "storage-failed"))).toBe(true)
  const pids = readFileSync(join(f.root, "worker-launches"), "utf8").trim().split("\n").map(Number)
  expect(pids).toHaveLength(1)
  expect(pids.every((pid) => !alive(pid))).toBe(true)
  expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
  expect(state(f).status.task0?.reason).toContain("AgentSpawnError")
  expect(c.stdout()).not.toContain("\"_tag\":\"Retry\"")
}, 30000)

test("crash during failed-task cleanup preserves the terminal timeout reason", async () => {
  const f = timedFixture("hold", "2 seconds", "10 seconds")
  mkdirSync(join(f.root, "bin"))
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  writeFileSync(
    join(f.root, "bin/git"),
    `#!${process.execPath}
const {spawnSync}=require('node:child_process'); const fs=require('node:fs');
if(process.argv[2]==='worktree' && process.argv[3]==='remove' && !fs.existsSync(${
      JSON.stringify(join(f.root, "cleanup-crash"))
    })) {
 fs.writeFileSync(${
      JSON.stringify(join(f.root, "cleanup-crash"))
    },'before cleanup'); process.kill(Number(spawnSync('ps',['-p',String(process.ppid),'-o','ppid='],{encoding:'utf8'}).stdout.trim()),'SIGKILL'); process.exit(1);
}
const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'}); process.exit(r.status ?? 1);
`,
    { mode: 0o700 },
  )
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(null)
  expect(existsSync(join(f.root, "cleanup-crash"))).toBe(true)
  const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
  expect(saved.taskReports.task0.phase).toBe("failed")
  expect(saved.taskReports.task0.failureReason).toMatch(/^AgentStalled:/)
  expect(await child(f, ["resume", "--json"]).done).toBe(1)
  expect(startsCount(f)).toBe(1)
  expect(state(f).status.task0?.reason).toMatch(/^AgentStalled:/)
  expect(existsSync(state(f).worktrees.task0!.path)).toBe(false)
}, 30000)

test("resume runs setup again when an interrupted worktree must be recreated", async () => {
  const f = timedFixture("retry-success", "5 minutes", "60 minutes", "echo setup >> \"$TEST_RECORDS/setup-count\"")
  const c = child(f, ["run", "TASKS.md", "--json"])
  await wait(() => c.stdout().includes("\"_tag\":\"Retry\""))
  const events: import("@agentrun/core").AgentEvent[] = readFileSync(
    join(artifacts(f), "tasks/task0/events.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line))
  expect(events.filter((event) => event._tag === "Retry")).toEqual([
    { _tag: "Retry", source: "runner", attempt: 2, reason: expect.stringMatching(/^AgentCrashed:/) },
  ])
  expect(startsCount(f)).toBe(1)
  c.p.kill("SIGINT")
  expect(await c.done).toBe(130)
  expect(state(f).status.task0?._tag).toBe("interrupted")
  expect(JSON.parse(readFileSync(statePath(f), "utf8")).taskReports.task0.setupCompleted).toBe(true)
  git(f.repo, ["worktree", "remove", state(f).worktrees.task0!.path])
  expect(await child(f, ["resume", "--json"]).done).toBe(0)
  expect(readFileSync(join(f.root, "setup-count"), "utf8").trim().split("\n")).toHaveLength(2)
  expect(startsCount(f)).toBe(3)
}, 30000)

test("review storage cause is refused across worker transport", async () => {
  const f = timedFixture("spawn-storage")
  writeFileSync(
    join(f.root, "crash.cjs"),
    `
const fs=require('node:fs'); const cp=require('node:child_process'); const original=cp.spawn;
cp.spawn=function(command,args,options){const p=original.call(this,command,args,options);
if(args?.some(a=>String(a).startsWith('agentrun-worker-'))) fs.appendFileSync(${
      JSON.stringify(join(f.root, "launches"))
    },p.pid+'\\n'); return p;};
`,
  )
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(1)
  const pids = readFileSync(join(f.root, "launches"), "utf8").trim().split("\n").map(Number)
  expect(pids).toHaveLength(1)
  expect(pids.every((pid) => !alive(pid))).toBe(true)
  expect(JSON.parse(readFileSync(statePath(f), "utf8")).taskReports.task0.adapterAttempt).toBe(1)
}, 30000)

test("review explicit failed retry recreates ignored setup dependency", async () => {
  const f = timedFixture(
    "setup-dependency",
    "5 minutes",
    "60 minutes",
    "echo setup >> \"$TEST_RECORDS/setup-count\"; touch dependency",
  )
  writeFileSync(join(f.repo, ".gitignore"), ".agentrun/\ndependency\n")
  git(f.repo, ["add", ".gitignore"])
  git(f.repo, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "ignore dependency"])
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(1)
  expect(state(f).status.task0?.reason).toBe("AgentTaskFailed: dependency or first failure")
  const events: import("@agentrun/core").AgentEvent[] = readFileSync(
    join(artifacts(f), "tasks/task0/events.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line))
  expect(events).toEqual([{ _tag: "Started" }, { _tag: "Failed", reason: "dependency or first failure" }])
  expect(startsCount(f)).toBe(1)
  expect(readFileSync(join(f.root, "setup-count"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(JSON.parse(readFileSync(statePath(f), "utf8")).taskReports.task0.setupCompleted).toBe(true)
  expect(existsSync(state(f).worktrees.task0!.path)).toBe(false)
  expect(await child(f, ["resume", "--retry-failed", "--json"]).done).toBe(0)
  expect(state(f).status.task0?._tag).toBe("succeeded")
  expect(startsCount(f)).toBe(2)
  expect(readFileSync(join(f.root, "setup-count"), "utf8").trim().split("\n")).toHaveLength(2)
}, 30000)

for (const mode of ["protocol", "stall", "ceiling"] as const) {
  test(`review crash during worker cleanup preserves ${mode} decision`, async () => {
    const f = timedFixture(
      mode === "protocol" ? "slow-cleanup cleanup-protocol" : "slow-cleanup hold",
      mode === "stall" ? "2 seconds" : "20 seconds",
      mode === "ceiling" ? "2 seconds" : "20 seconds",
    )
    const c = child(f, ["run", "TASKS.md", "--json"])
    await wait(() => existsSync(join(f.root, "cleanup-started")))
    const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
    const pgid = saved.worktrees.task0.pgid
    const oldChild = existsSync(join(f.root, "child-task0"))
      ? Number(readFileSync(join(f.root, "child-task0"), "utf8"))
      : undefined
    c.p.kill("SIGKILL")
    expect(await c.done).toBe(null)
    expect(saved.taskReports.task0.phase).toBe("failed")
    const tag = mode === "protocol" ? "AgentProtocolError" : mode === "stall" ? "AgentStalled" : "AgentTimedOut"
    expect(saved.taskReports.task0.failureReason).toMatch(new RegExp(`^${tag}:`))
    expect(await child(f, ["resume", "--json"]).done).toBe(1)
    expect(startsCount(f)).toBe(1)
    expect(alive(pgid)).toBe(false)
    if (oldChild !== undefined) expect(alive(oldChild)).toBe(false)
    expect(state(f).status.task0?.reason).toMatch(new RegExp(`^${tag}:`))
    expect(existsSync(lockPath(f))).toBe(false)
  }, 30000)
}

const hangingGit = (f: Fixture, operation: "acquire" | "delivery") => {
  mkdirSync(join(f.root, "bin"))
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const handler = join(f.root, "bin/git-hang.cjs")
  writeFileSync(
    join(f.root, "bin/git"),
    `#!/bin/sh
if [ ! -e ${quote(join(f.root, "git-hang"))} ] && ${
      operation === "acquire" ? "[ \"$1\" = worktree ] && [ \"$2\" = add ]" : "[ \"$1\" = update-ref ]"
    }; then
 exec ${quote(process.execPath)} ${quote(handler)} "$@"
fi
exec ${quote(realGit)} "$@"
`,
    { mode: 0o700 },
  )
  writeFileSync(
    handler,
    `#!${process.execPath}
const {spawn,spawnSync}=require('node:child_process'); const fs=require('node:fs');
const args=process.argv.slice(2); const marker=${JSON.stringify(join(f.root, "git-hang"))};
if(!fs.existsSync(marker) && (${
      operation === "acquire" ? "args[0]==='worktree' && args[1]==='add'" : "args[0]==='update-ref'"
    })) {
 ${
      operation === "acquire"
        ? "const created=spawnSync(" + JSON.stringify(realGit)
          + ",args,{stdio:'inherit'}); if(created.status!==0) process.exit(created.status ?? 1);"
        : ""
    }
 const c=spawn('sleep',['300'],{stdio:'ignore'}); fs.writeFileSync(marker,JSON.stringify({pid:process.pid,child:c.pid,args}));
 process.on('SIGTERM',()=>fs.writeFileSync(${
      JSON.stringify(join(f.root, "git-cleanup"))
    },'ready')); setInterval(()=>{},1000);
} else {const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}); process.exit(r.status ?? 1);}
`,
    { mode: 0o700 },
  )
}

for (const dirty of [false, true]) {
  test(`review hanging Git acquisition times out and releases queued work (${dirty ? "dirty" : "clean"})`, async () => {
    const f = fixture(2)
    writeFileSync(
      join(f.repo, "TASKS.md"),
      "## task0: First\nmaxDuration: 5 seconds\nstallTimeout: 20 seconds\n\nsuccess\n\n## task1: Queued\n\nsuccess\n",
    )
    hangingGit(f, "acquire")
    const c = child(f, ["run", "TASKS.md", "--json", "--concurrency", "1"])
    try {
      await wait(() => existsSync(join(f.root, "git-hang")))
      const partial = state(f).worktrees.task0!.path
      expect(existsSync(partial)).toBe(true)
      if (dirty) writeFileSync(join(partial, "partial-user-work"), "preserve this\n")
      expect(await c.done).toBe(1)
      expect(c.stdout().trim().split("\n").at(-1)).toContain("\"_tag\":\"RunFinished\"")
      const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
      expect(saved.tasks).toMatchObject([
        { id: "task0", maxDuration: { _tag: "Millis", value: 5000 }, stallTimeout: { _tag: "Millis", value: 20000 } },
        {
          id: "task1",
          maxDuration: { _tag: "Millis", value: 3600000 },
          stallTimeout: { _tag: "Millis", value: 300000 },
        },
      ])
      expect(state(f).status.task0?.reason).toBe("AgentTimedOut: Exceeded 5000ms")
      expect(state(f).status.task1?._tag).toBe("succeeded")
      expect(readFileSync(join(f.root, "starts-task1"), "utf8").trim().split("\n")).toHaveLength(1)
      const owned = JSON.parse(readFileSync(join(f.root, "git-hang"), "utf8"))
      expect(alive(owned.pid)).toBe(false)
      expect(alive(owned.child)).toBe(false)
      expect(existsSync(lockPath(f))).toBe(false)
      expect(existsSync(join(f.repo, ".agentrun/runs", state(f).runId, "report.json"))).toBe(true)
      const refused = child(f, ["resume", "--json"])
      expect(await refused.done).toBe(1)
      expect(refused.stderr()).toMatch(/[Oo]wnership/)
      expect(existsSync(partial)).toBe(true)
      if (dirty) expect(readFileSync(join(partial, "partial-user-work"), "utf8")).toBe("preserve this\n")
      expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
    } finally {
      if (alive(c.p.pid!)) c.p.kill("SIGKILL")
      await c.done
      if (existsSync(join(f.root, "git-hang"))) {
        const owned = JSON.parse(readFileSync(join(f.root, "git-hang"), "utf8"))
        for (const pid of [owned.pid, owned.child]) if (alive(pid)) process.kill(pid, "SIGKILL")
      }
    }
  }, 30000)
}

for (const crash of [false, true]) {
  test(
    `review hanging delivery Git preserves immutable recovery without provider replay (${crash ? "crash" : "timeout"})`,
    async () => {
      const f = timedFixture("success", "5 minutes", "30 seconds")
      hangingGit(f, "delivery")
      const c = child(f, ["run", "TASKS.md", "--json", "--keep-worktrees"])
      try {
        await wait(() => existsSync(join(f.root, "git-hang")), 60000)
        const checkpoint = JSON.parse(readFileSync(statePath(f), "utf8"))
        writeFileSync(join(f.root, "delivery-hang-state.json"), readFileSync(statePath(f)))
        expect(checkpoint.tasks).toMatchObject([
          {
            id: "task0",
            maxDuration: { _tag: "Millis", value: 30000 },
            stallTimeout: { _tag: "Millis", value: 300000 },
          },
        ])
        expect(startsCount(f)).toBe(1)
        expect(checkpoint.taskReports.task0.phase).toBe("completed")
        expect(checkpoint.taskReports.task0.deliveryCommit).toMatch(/^[a-f0-9]{40}$/)
        const owned = JSON.parse(readFileSync(join(f.root, "git-hang"), "utf8"))
        expect(owned.args).toEqual([
          "update-ref",
          `refs/heads/${checkpoint.worktrees.task0.branch}`,
          checkpoint.taskReports.task0.deliveryCommit,
          checkpoint.baseSha,
        ])
        if (crash) {
          await wait(() => existsSync(join(f.root, "git-cleanup")), 60000)
          expect(readFileSync(join(f.root, "git-cleanup"), "utf8")).toBe("ready")
          c.p.kill("SIGKILL")
          expect(await c.done).toBe(null)
        } else {
          expect(await c.done).toBe(1)
          expect(c.stdout().trim().split("\n").at(-1)).toContain("\"_tag\":\"RunFinished\"")
          expect(state(f).status.task0?.reason).toBe("AgentTimedOut: Exceeded 30000ms")
        }
        const saved = JSON.parse(readFileSync(statePath(f), "utf8"))
        expect(saved.taskReports.task0.phase).toBe("completed")
        const commit = saved.taskReports.task0.deliveryCommit
        expect(commit).toMatch(/^[a-f0-9]{40}$/)
        expect(commit).toBe(checkpoint.taskReports.task0.deliveryCommit)
        expect(saved.taskReports.task0).toEqual(checkpoint.taskReports.task0)
        if (!crash) {
          expect(alive(owned.pid)).toBe(false)
          expect(alive(owned.child)).toBe(false)
          expect(existsSync(lockPath(f))).toBe(false)
        }
        expect(await child(f, ["resume", "--json", "--keep-worktrees"]).done).toBe(0)
        expect(startsCount(f)).toBe(1)
        expect(alive(owned.pid)).toBe(false)
        expect(alive(owned.child)).toBe(false)
        expect(existsSync(lockPath(f))).toBe(false)
        expect(git(f.repo, ["rev-parse", state(f).worktrees.task0!.branch])).toBe(commit)
        const patch = join(f.repo, ".agentrun/runs", saved.runId, "tasks/task0/diff.patch")
        const bytes = readFileSync(patch)
        expect(await child(f, ["resume", "--json"]).done).toBe(0)
        expect(readFileSync(patch)).toEqual(bytes)
        expect(startsCount(f)).toBe(1)
      } finally {
        if (alive(c.p.pid!)) c.p.kill("SIGKILL")
        await c.done
        if (existsSync(join(f.root, "git-hang"))) {
          const owned = JSON.parse(readFileSync(join(f.root, "git-hang"), "utf8"))
          for (const pid of [owned.pid, owned.child]) if (alive(pid)) process.kill(pid, "SIGKILL")
        }
      }
    },
    120000,
  )
}

test("review partial acquisition clears setup before a failed retry can reuse the directory", async () => {
  const f = timedFixture(
    "setup-dependency",
    "5 minutes",
    "30 seconds",
    "echo setup >> \"$TEST_RECORDS/setup-count\"; touch dependency",
  )
  writeFileSync(join(f.repo, ".gitignore"), ".agentrun/\ndependency\n")
  git(f.repo, ["add", ".gitignore"])
  git(f.repo, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "ignore dependency"])
  expect(await child(f, ["run", "TASKS.md", "--json"]).done).toBe(1)
  const first = JSON.parse(readFileSync(statePath(f), "utf8"))
  writeFileSync(join(f.root, "first-failure-state.json"), readFileSync(statePath(f)))
  expect(first.tasks).toMatchObject([
    { id: "task0", maxDuration: { _tag: "Millis", value: 30000 }, stallTimeout: { _tag: "Millis", value: 300000 } },
  ])
  expect(first.status.task0).toEqual({
    _tag: "failed",
    attempt: 1,
    reason: "AgentTaskFailed: dependency or first failure",
  })
  expect(first.taskReports.task0).toMatchObject({
    phase: "failed",
    attempt: 1,
    failureReason: "AgentTaskFailed: dependency or first failure",
    setupCompleted: true,
    toolsStarted: false,
  })
  const events: import("@agentrun/core").AgentEvent[] = readFileSync(
    join(artifacts(f), "tasks/task0/events.jsonl"),
    "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line))
  expect(events).toEqual([{ _tag: "Started" }, { _tag: "Failed", reason: "dependency or first failure" }])
  writeFileSync(
    join(f.root, "first-failure-events.jsonl"),
    readFileSync(join(artifacts(f), "tasks/task0/events.jsonl")),
  )
  expect(startsCount(f)).toBe(1)
  expect(readFileSync(join(f.root, "setup-count"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(existsSync(first.worktrees.task0.path)).toBe(false)
  hangingGit(f, "acquire")
  const retry = child(f, ["resume", "--retry-failed", "--json"])
  await wait(() => existsSync(join(f.root, "git-hang")), 60000)
  const partial = state(f).worktrees.task0!.path
  expect(state(f).worktrees.task0).toEqual(first.worktrees.task0)
  expect(existsSync(partial)).toBe(true)
  const owned = JSON.parse(readFileSync(join(f.root, "git-hang"), "utf8"))
  expect(owned.args).toEqual(["worktree", "add", partial, first.worktrees.task0.branch])
  writeFileSync(join(partial, "partial-user-work"), "preserve this\n")
  expect(await retry.done).toBe(1)
  expect(state(f).status.task0?.reason).toMatch(/^AgentTimedOut:/)
  expect(retry.stdout().trim().split("\n").at(-1)).toContain("\"_tag\":\"RunFinished\"")
  const middle = JSON.parse(readFileSync(statePath(f), "utf8"))
  writeFileSync(join(f.root, "acquisition-timeout-state.json"), readFileSync(statePath(f)))
  expect(middle.tasks).toEqual(first.tasks)
  expect(middle.status.task0).toEqual({ _tag: "failed", attempt: 2, reason: "AgentTimedOut: Exceeded 30000ms" })
  expect(middle.taskReports.task0).toMatchObject({
    phase: "failed",
    attempt: 2,
    failureReason: "AgentTimedOut: Exceeded 30000ms",
    setupCompleted: false,
  })
  expect(existsSync(partial)).toBe(true)
  expect(startsCount(f)).toBe(1)
  expect(readFileSync(join(f.root, "setup-count"), "utf8").trim().split("\n")).toHaveLength(1)
  expect(existsSync(join(partial, "dependency"))).toBe(false)
  expect(alive(owned.pid)).toBe(false)
  expect(alive(owned.child)).toBe(false)
  expect(existsSync(lockPath(f))).toBe(false)
  expect(await child(f, ["resume", "--retry-failed", "--json"]).done).toBe(0)
  expect(state(f).status.task0?._tag).toBe("succeeded")
  expect(JSON.parse(readFileSync(statePath(f), "utf8")).taskReports.task0).toMatchObject({
    phase: "delivered",
    setupCompleted: true,
  })
  expect(JSON.parse(readFileSync(statePath(f), "utf8")).tasks).toEqual(first.tasks)
  expect(startsCount(f)).toBe(2)
  expect(readFileSync(join(f.root, "setup-count"), "utf8").trim().split("\n")).toHaveLength(2)
  expect(git(f.repo, ["show", `${state(f).worktrees.task0!.branch}:partial-user-work`])).toBe("preserve this")
  const contents = spawnSync("git", ["show", `${state(f).worktrees.task0!.branch}:partial-user-work`], { cwd: f.repo })
  expect(contents.status).toBe(0)
  writeFileSync(join(f.root, "delivered-partial-user-work"), contents.stdout)
  expect(contents.stdout).toEqual(Buffer.from("preserve this\n"))
}, 120000)

for (const id of ["../escape", "bad/id", "bad\\id", ".", "-bad", "a".repeat(129)]) {
  test(`explicit run identity rejects invalid ID ${id}`, async () => {
    const f = fixture(1)
    const c = child(f, ["run", "TASKS.md", `--run-id=${id}`, "--json"], true)
    expect(await c.done).toBe(2)
    expect(c.stderr()).toContain("Invalid run ID")
    expect(existsSync(join(f.repo, ".agentrun"))).toBe(false)
    expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
  }, 30000)
}

test("explicit run identity preserves completed artifacts on repeated dispatch", async () => {
  const f = fixture(1, "report-bytes")
  const id = "caller-attempt-a1b2"
  const args = ["run", "TASKS.md", "--run-id", id, "--json"]
  expect(await child(f, args).done).toBe(0)
  expect(state(f).runId).toBe(id)
  const files = ["state.json", "report.json", "report.md", "tasks/task0/events.jsonl", "tasks/task0/diff.patch"]
  const before = files.map((file) => readFileSync(join(artifacts(f), file)))
  const refs = git(f.repo, ["show-ref"])
  const duplicate = child(f, args)
  expect(await duplicate.done).toBe(2)
  expect(duplicate.stderr()).toContain("already exists")
  expect(files.map((file) => readFileSync(join(artifacts(f), file)))).toEqual(before)
  expect(git(f.repo, ["show-ref"])).toBe(refs)
  expect(starts(f)).toBe(1)
  expect(await child(f, ["resume", id, "--json"]).done).toBe(0)
  expect(starts(f)).toBe(1)
}, 30000)

for (const leftover of ["empty", "temporary", "corrupt"] as const) {
  test(`explicit run identity preserves ${leftover} reservation`, async () => {
    const f = fixture(1)
    const id = "reserved-a1b2"
    const dir = join(f.repo, ".agentrun/runs", id)
    mkdirSync(dir, { recursive: true })
    const file = leftover === "temporary" ? "state.json.tmp" : "state.json"
    f.ownership.incompleteStates.add(join(dir, "state.json"))
    if (leftover !== "empty") writeFileSync(join(dir, file), "incomplete original bytes")
    const c = child(f, ["run", "TASKS.md", "--run-id", id, "--json"])
    expect(await c.done).toBe(2)
    expect(c.stderr()).toContain("already exists")
    expect(readdirSync(dir)).toEqual(leftover === "empty" ? [] : [file])
    if (leftover !== "empty") expect(readFileSync(join(dir, file), "utf8")).toBe("incomplete original bytes")
    expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
    expect(git(f.repo, ["branch", "--list", "agentrun/*"])).toBe("")
  }, 30000)
}

test("concurrent explicit dispatch has one owner and preserves its pending work", async () => {
  const f = fixture(1, "hold")
  const id = "concurrent-a1b2"
  const args = ["run", "TASKS.md", "--run-id", id, "--json"]
  const first = child(f, args)
  const second = child(f, args)
  await wait(() => existsSync(join(f.root, "child-task0")))
  const ownerPid = Number(readFileSync(lockPath(f), "utf8"))
  const owner = first.p.pid === ownerPid ? first : second
  const rejected = owner === first ? second : first
  expect(owner.p.pid).toBe(ownerPid)
  expect(await rejected.done).toBe(1)
  expect(rejected.stderr()).toContain("RunLocked")
  expect(state(f).runId).toBe(id)
  expect(starts(f)).toBe(1)
  expect(readdirSync(join(f.repo, ".agentrun/runs"))).toEqual([id])
  owner.p.kill("SIGINT")
  expect(await owner.done).toBe(130)
  const before = readFileSync(statePath(f))
  expect(await child(f, args).done).toBe(2)
  expect(readFileSync(statePath(f))).toEqual(before)
}, 30000)

test("a suffix collision preserves the prior delivery without reserving a new run", async () => {
  const f = fixture(1)
  expect(await child(f, ["run", "TASKS.md", "--run-id", "first-a1b2", "--json"]).done).toBe(0)
  const before = readFileSync(statePath(f))
  const refs = git(f.repo, ["show-ref"])
  const c = child(f, ["run", "TASKS.md", "--run-id", "second-a1b2", "--json"])
  expect(await c.done).toBe(2)
  expect(c.stderr()).toMatch(/[Cc]ollision/)
  expect(readFileSync(statePath(f))).toEqual(before)
  expect(git(f.repo, ["show-ref"])).toBe(refs)
  expect(starts(f)).toBe(1)
  expect(existsSync(join(f.repo, ".agentrun/runs/second-a1b2"))).toBe(false)
}, 30000)

for (const window of ["reservation", "initial", "completed"] as const) {
  test(`explicit identity recovers the ${window} crash window without guessing latest`, async () => {
    const f = fixture(1)
    const id = "crash-a1b2"
    writeFileSync(
      join(f.root, "crash.cjs"),
      `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const marker = ${JSON.stringify(join(f.root, "crashed"))};
const original = fs.${window === "reservation" ? "writeFile" : "rename"};
const crash = (target) => {
  if (!fs.existsSync(marker) && String(target).endsWith('/${id}/state.json${window === "reservation" ? ".tmp" : ""}')) {
    ${
        window === "completed"
          ? "if (JSON.parse(fs.readFileSync(target, 'utf8')).taskReports?.task0?.phase !== 'completed') return;"
          : ""
      }
    fs.writeFileSync(marker, String(target)); process.kill(process.pid, 'SIGKILL');
  }
};
fs.${window === "reservation" ? "writeFile" : "rename"} = function(...args) {
  ${
        window === "reservation"
          ? "crash(args[0]); return original.apply(this, args);"
          : `const callback = args.pop(); return original.call(this, ...args, (error) => {
    if (!error) crash(args[1]); callback(error);
  });`
      }
};
syncBuiltinESMExports();
`,
    )
    expect(await child(f, ["run", "TASKS.md", "--run-id", id, "--json"]).done).toBe(null)
    expect(existsSync(join(f.root, "crashed"))).toBe(true)
    expect(await child(f, ["run", "TASKS.md", "--run-id", id, "--json"]).done).toBe(2)
    if (window === "reservation") {
      expect(await child(f, ["resume", id, "--json"]).done).toBe(2)
      expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
      expect(readdirSync(join(f.repo, ".agentrun/runs", id))).toEqual([])
    } else {
      f.ownership.incompleteStates.add(join(f.repo, ".agentrun/runs/zz-later/state.json"))
      mkdirSync(join(f.repo, ".agentrun/runs/zz-later"))
      writeFileSync(join(f.repo, ".agentrun/runs/zz-later/state.json"), "foreign incomplete state")
      expect(await child(f, ["resume", id, "--json"]).done).toBe(0)
      expect(JSON.parse(readFileSync(join(f.repo, ".agentrun/runs", id, "state.json"), "utf8")).status.task0._tag).toBe(
        "succeeded",
      )
      expect(starts(f)).toBe(1)
      expect(readFileSync(join(f.repo, ".agentrun/runs/zz-later/state.json"), "utf8")).toBe("foreign incomplete state")
    }
  }, 30000)
}

test("resume verifies the identity reloaded under the owner lock", async () => {
  const f = fixture(1)
  const id = "locked-a1b2"
  expect(await child(f, ["run", "TASKS.md", "--run-id", id, "--json"]).done).toBe(0)
  const before = readFileSync(statePath(f))
  writeFileSync(
    join(f.root, "crash.cjs"),
    `
const fs = require('node:fs'); const original = fs.readFile; let reads = 0;
const { syncBuiltinESMExports } = require('node:module');
fs.readFile = function(...args) {
  const callback = args.pop();
  return original.call(this, ...args, (error, value) => {
    if (!error && String(args[0]).endsWith('/${id}/state.json') && ++reads === 2) {
      const saved = JSON.parse(value); saved.runId = 'different-c3d4';
      const text = JSON.stringify(saved); value = Buffer.isBuffer(value) ? Buffer.from(text) : text;
    }
    callback(error, value);
  });
};
syncBuiltinESMExports();
`,
  )
  const c = child(f, ["resume", id, "--json"])
  expect(await c.done).toBe(2)
  expect(c.stderr()).toContain("identity differs")
  expect(readFileSync(statePath(f))).toEqual(before)
  expect(starts(f)).toBe(1)
}, 30000)

for (const agent of ["claude-code", "pi"] as const) {
  test(`read-only ${agent} profile crosses the production worker protocol`, async () => {
    const f = fixture(1, "report-nochange")
    writeFileSync(
      join(f.repo, "TASKS.md"),
      `---\nagent: ${agent}\ntools: read-only\n---\n## task0: Review\nreport-nochange\n`,
    )
    expect(await child(f, ["run", "TASKS.md", "--run-id", "review-a1b2", "--json"]).done).toBe(0)
    expect(readFileSync(join(f.root, "tools-task0"), "utf8")).toBe("read-only")
    expect(reportJson(f).tasks[0].tools).toBe("read-only")
    expect(reportJson(f).taskReports.task0.deliveryCommit).toBe(state(f).baseSha)
    expect(readFileSync(join(artifacts(f), "tasks/task0/diff.patch"))).toEqual(Buffer.alloc(0))
  }, 30000)
}

test("restricted settings and setup fail preflight without run or worker effects", async () => {
  for (const settings of [false, true]) {
    const f = fixture(1)
    writeFileSync(
      join(f.repo, "TASKS.md"),
      `---\ntools: read-only\n${settings ? "" : "setup: touch forbidden\n"}---\n## task0: Review\nInspect.\n`,
    )
    const c = child(f, ["run", "TASKS.md", "--json", ...(settings ? ["--load-project-settings"] : [])], true)
    expect(await c.done).toBe(2)
    expect(c.stderr()).toContain("read-only")
    expect(existsSync(join(f.repo, ".agentrun"))).toBe(false)
    expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
  }
}, 30000)

for (const mode of ["failed retry", "interrupted", "linked checkout"] as const) {
  test(`ownership refuses foreign suffix delivery after ${mode}`, async () => {
    const f = fixture(1, "report-nochange")
    const id = "first-0001"
    const branch = "agentrun/task0-0001"
    const lock = join(f.repo, ".git/refs/heads", `${branch}.lock`)
    mkdirSync(join(f.repo, ".git/refs/heads/agentrun"), { recursive: true })
    writeFileSync(lock, "fixture ref lock")
    expect(await child(f, ["run", "TASKS.md", "--run-id", id, "--json"]).done).toBe(1)
    const file = join(f.repo, ".agentrun/runs", id, "state.json")
    const initial = JSON.parse(readFileSync(file, "utf8"))
    expect(initial.status.task0._tag).toBe("failed")
    expect(initial.worktrees.task0.branch).toBe(branch)
    expect(existsSync(initial.worktrees.task0.path)).toBe(false)
    expect(git(f.repo, ["branch", "--list", branch])).toBe("")
    expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
    unlinkSync(lock)
    if (mode === "interrupted") {
      initial.status.task0 = { _tag: "interrupted", attempt: 1 }
      initial.taskReports.task0 = { phase: "unfinished", attempt: 1, toolsStarted: false, eventOffset: 0 }
      writeFileSync(file, JSON.stringify(initial))
    }
    const second = mode === "linked checkout" ? { ...f, repo: join(f.root, "linked") } : f
    if (second !== f) git(f.repo, ["worktree", "add", "-b", "linked", second.repo, "HEAD"])
    writeFileSync(join(second.repo, "SECOND.md"), "## task0: Foreign delivery\nreport-bytes\n")
    expect(await child(second, ["run", "SECOND.md", "--run-id", "second-0001", "--json"]).done).toBe(0)
    const before = readFileSync(file)
    const refs = git(f.repo, ["show-ref"])
    const otherReport = readFileSync(join(second.repo, ".agentrun/runs/second-0001/report.json"))
    const resumed = child(f, ["resume", id, ...(mode === "interrupted" ? [] : ["--retry-failed"]), "--json"])
    expect(await resumed.done).toBe(1)
    expect(resumed.stderr()).toMatch(/[Oo]wnership/)
    expect(resumed.stderr()).toMatch(/[Pp]reserve|[Ii]nspect/)
    expect(starts(f)).toBe(1)
    expect(readFileSync(file)).toEqual(before)
    expect(git(f.repo, ["show-ref"])).toBe(refs)
    expect(readFileSync(join(second.repo, ".agentrun/runs/second-0001/report.json"))).toEqual(otherReport)
    expect(existsSync(initial.worktrees.task0.path)).toBe(false)
  }, 30000)
}

for (const packed of [false, true]) {
  test(`ownership refuses case-only ${packed ? "packed" : "loose"} branch collisions before reservation`, async () => {
    const f = fixture(1, "report-bytes")
    expect(await child(f, ["run", "TASKS.md", "--run-id", "first-A1B2", "--json"]).done).toBe(0)
    if (packed) git(f.repo, ["pack-refs", "--all", "--prune"])
    const tip = git(f.repo, ["rev-parse", "refs/heads/agentrun/task0-A1B2"])
    const before = readFileSync(statePath(f))
    const second = child(f, ["run", "TASKS.md", "--run-id", "second-a1b2", "--json"])
    expect(await second.done).toBe(2)
    expect(second.stderr()).toMatch(/[Cc]ollision/)
    expect(existsSync(join(f.repo, ".agentrun/runs/second-a1b2"))).toBe(false)
    expect(git(f.repo, ["rev-parse", "refs/heads/agentrun/task0-A1B2"])).toBe(tip)
    expect(readFileSync(statePath(f))).toEqual(before)
    expect(starts(f)).toBe(1)
  }, 30000)
}

for (const linked of [false, true]) {
  test(`ownership reserves case-folded run IDs across ${linked ? "linked checkouts" : "task names"}`, async () => {
    const f = fixture(1)
    expect(await child(f, ["run", "TASKS.md", "--run-id", "First-A1B2", "--json"]).done).toBe(0)
    const before = readFileSync(statePath(f))
    const second = linked ? { ...f, repo: join(f.root, "linked") } : f
    if (linked) git(f.repo, ["worktree", "add", "-b", "linked", second.repo, "HEAD"])
    writeFileSync(join(second.repo, "OTHER.md"), "## other: Other task\nsuccess\n")
    const duplicate = child(second, ["run", "OTHER.md", "--run-id", "first-a1b2", "--json"])
    expect(await duplicate.done).toBe(2)
    expect(duplicate.stderr()).toContain("already exists")
    expect(readFileSync(join(f.repo, ".agentrun/runs/First-A1B2/state.json"))).toEqual(before)
    expect(existsSync(join(f.root, "starts-other"))).toBe(false)
    expect(git(f.repo, ["branch", "--list", "agentrun/other-*"])).toBe("")
  }, 30000)
}

test("ownership gives actionable empty reservation refusal without changing its bytes", async () => {
  const f = fixture(1)
  const id = "empty-0042"
  const directory = join(f.repo, ".agentrun/runs", id)
  mkdirSync(directory, { recursive: true })
  for (const args of [["run", "TASKS.md", "--run-id", id, "--json"], ["resume", id, "--json"]]) {
    const refused = child(f, args)
    expect(await refused.done).toBe(2)
    expect(refused.stderr()).toMatch(/[Rr]eserv/)
    expect(refused.stderr()).toMatch(/[Pp]reserve/)
    expect(refused.stderr()).toMatch(/[Ii]nspect/)
    expect(refused.stderr()).not.toContain("use resume with this exact ID")
  }
  expect(readdirSync(directory)).toEqual([])
  expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
  expect(git(f.repo, ["branch", "--list", "agentrun/*"])).toBe("")
}, 30000)

test("ownership preserves creation interrupted before proof is saved", async () => {
  const f = fixture(1)
  hangingGit(f, "acquire")
  const running = child(f, ["run", "TASKS.md", "--run-id", "partial-0042", "--json"])
  await wait(() => existsSync(join(f.root, "git-hang")))
  running.p.kill("SIGINT")
  expect(await running.done).toBe(130)
  const saved = state(f)
  expect(saved.status.task0?._tag).toBe("interrupted")
  const worktree = saved.worktrees.task0!
  expect(existsSync(worktree.path)).toBe(true)
  writeFileSync(join(worktree.path, "keep"), "unproved work")
  const before = readFileSync(statePath(f))
  const tip = git(f.repo, ["rev-parse", worktree.branch])
  const resumed = child(f, ["resume", saved.runId, "--json"])
  expect(await resumed.done).toBe(1)
  expect(resumed.stderr()).toMatch(/[Oo]wnership/)
  expect(readFileSync(statePath(f))).toEqual(before)
  expect(git(f.repo, ["rev-parse", worktree.branch])).toBe(tip)
  expect(readFileSync(join(worktree.path, "keep"), "utf8")).toBe("unproved work")
  expect(existsSync(join(f.root, "starts-task0"))).toBe(false)
}, 30000)
