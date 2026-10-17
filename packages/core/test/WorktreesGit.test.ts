import { NodeServices } from "@effect/platform-node"
import { Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { expect, test, vi } from "vitest"
import { Task, TaskId } from "../src/domain/Task.js"
import { Worktrees } from "../src/Worktrees.js"

const bytes = Buffer.from(Array.from({ length: 262144 }, (_, index) => index % 256))

const withGit = async (
  mode: string,
  check: (root: string, diff: Effect.Effect<Uint8Array, unknown>) => Promise<void>,
) => {
  const root = mkdtempSync(join(tmpdir(), "agentrun-git-lifecycle-"))
  const original = process.env.PATH
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  git("init", "-q")
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "base",
  )
  const base = git("rev-parse", "HEAD")
  writeFileSync(
    join(root, "git"),
    `#!${process.execPath}
const {spawn,spawnSync}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)};
if(process.argv[2]!=='diff') {
 const result=spawnSync('/usr/bin/git',process.argv.slice(2),{stdio:'inherit'});
 process.exit(result.status??1);
}
writeFileSync(root+'/leader',String(process.ppid));
if(mode==='active') { setInterval(()=>{},1000); }
else {
 if(mode==='survivor') {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  writeFileSync(root+'/survivor',String(child.pid));child.unref();
 }
 if(mode==='crash')process.kill(process.ppid,'SIGKILL');
 process.stdout.write(Buffer.from(Array.from({length:262144},(_,i)=>i%256)));
 process.stderr.write('literal Git error\\n');
 process.exitCode=mode==='failure'?23:0;
}
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(root, "ps"),
    `#!/bin/sh\nif [ "$2" != 'pid=,pgid=,stat=' ]; then echo scan >> '${root}/scans'; fi\nexec /bin/ps "$@"\n`,
    { mode: 0o755 },
  )
  try {
    process.env.PATH = `${root}:${original}`
    const taskId = Schema.decodeSync(TaskId)("probe")
    const diff = Effect.gen(function*() {
      const worktrees = yield* Worktrees
      return yield* worktrees.diff(worktrees.locate(taskId), base, base)
    }).pipe(
      Effect.provide(
        Worktrees.layer({ repoRoot: root, home: root, runId: "probe" }).pipe(Layer.provide(NodeServices.layer)),
      ),
    )
    await check(root, diff)
  } finally {
    process.env.PATH = original
    if (existsSync(join(root, "survivor"))) {
      const pid = Number(readFileSync(join(root, "survivor"), "utf8"))
      try {
        process.kill(pid, "SIGKILL")
      } catch { /* The test owns this child, which may already have exited. */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
}

const journal = (root: string): string[] =>
  readdirSync(join(root, ".agentrun", "git"), { recursive: true }).map(String).filter((file) => file.endsWith(".json"))

for (const mode of ["success", "failure"]) {
  test(`completed Git ${mode} exits without parent cleanup scans or signals`, async () => {
    await withGit(mode, async (root, diff) => {
      const signals: string[] = []
      const kill = process.kill.bind(process)
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (
          signal !== 0 && existsSync(join(root, "leader"))
          && pid === -Number(readFileSync(join(root, "leader"), "utf8"))
        ) signals.push(String(signal))
        return kill(pid, signal)
      })
      try {
        if (mode === "success") expect(Buffer.from(await Effect.runPromise(diff))).toEqual(bytes)
        else {
          const result = await Effect.runPromise(Effect.flip(diff))
          expect(result).toMatchObject({ _tag: "GitError", exitCode: 23, stderr: "literal Git error\n" })
        }
        expect(journal(root)).toEqual([])
        expect(() => process.kill(Number(readFileSync(join(root, "leader"), "utf8")), 0)).toThrow()
        expect(signals).toEqual([])
        expect(existsSync(join(root, "scans"))).toBe(false)
      } finally {
        spy.mockRestore()
      }
    })
  })
}

test("interrupting active Git verifies and stops its group before removing the journal", async () => {
  await withGit("active", async (root, diff) => {
    const fiber = Effect.runFork(diff)
    try {
      const deadline = Date.now() + 10000
      while (!existsSync(join(root, "leader"))) {
        if (Date.now() > deadline) throw new Error("Git did not start")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(journal(root)).toHaveLength(1)
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
    expect(journal(root)).toEqual([])
    expect(existsSync(join(root, "scans"))).toBe(true)
    expect(() => process.kill(-Number(readFileSync(join(root, "leader"), "utf8")), 0)).toThrow()
  })
})

test("a Git wrapper that exits without status fails promptly", async () => {
  await withGit("crash", async (_root, diff) => {
    const result = await Effect.runPromiseExit(diff.pipe(Effect.timeout("10 seconds")))
    expect(Exit.isFailure(result)).toBe(true)
    expect(inspect(result, { depth: 10 })).toContain("Git wrapper exited without status")
  })
})

test("a surviving Git child is stopped through its verified leader and the call succeeds", async () => {
  await withGit("survivor", async (root, diff) => {
    const signals: string[] = []
    const kill = process.kill.bind(process)
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (
        signal !== 0 && existsSync(join(root, "leader")) && pid === -Number(readFileSync(join(root, "leader"), "utf8"))
      ) signals.push(String(signal))
      return kill(pid, signal)
    })
    try {
      const result = await Effect.runPromiseExit(diff)
      expect(Exit.isSuccess(result)).toBe(true)
      expect(signals).toEqual(["SIGTERM"])
      expect(journal(root)).toEqual([])
      expect(() => process.kill(Number(readFileSync(join(root, "survivor"), "utf8")), 0)).toThrow()
    } finally {
      spy.mockRestore()
    }
  })
}, 60000)

test("Git status is sent after both output streams finish", async () => {
  await withGit("success", async (root, diff) => {
    const executable = process.execPath
    const preload = join(root, "observe-status.cjs")
    const launcher = join(root, "node-wrapper")
    writeFileSync(
      preload,
      `const {writeFileSync}=require('node:fs');
if(process.argv.at(-1)?.startsWith('agentrun-git-')){
let stdout=false,stderr=false;
process.stdout.once('finish',()=>{stdout=true});
process.stderr.once('finish',()=>{stderr=true});
const send=process.send.bind(process);
process.send=(...args)=>{
 writeFileSync(${JSON.stringify(join(root, "output-finished"))},JSON.stringify({stdout,stderr}));
 return send(...args);
};
}
`,
    )
    writeFileSync(launcher, `#!/bin/sh\nexec '${executable}' --require '${preload}' "$@"\n`, { mode: 0o755 })
    try {
      Object.defineProperty(process, "execPath", { value: launcher })
      expect(Buffer.from(await Effect.runPromise(diff))).toEqual(bytes)
      expect(JSON.parse(readFileSync(join(root, "output-finished"), "utf8"))).toEqual({ stdout: true, stderr: true })
    } finally {
      Object.defineProperty(process, "execPath", { value: executable })
    }
  })
})

test("a real post-checkout hook child is stopped before acquire succeeds and recovery stays usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentrun-git-hook-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  git("init", "-q")
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "base",
  )
  const base = git("rev-parse", "HEAD")
  const survivor = join(root, "hook-child")
  writeFileSync(
    join(root, ".git", "hooks", "post-checkout"),
    `#!/bin/sh
sleep 20 </dev/null >/dev/null 2>&1 &
echo $! > '${survivor}'
`,
    { mode: 0o755 },
  )
  const task = new Task({
    id: Schema.decodeSync(TaskId)("hook"),
    title: "Hook",
    prompt: "Hook",
    agent: "claude-code",
    stallTimeout: Duration.minutes(1),
    maxDuration: Duration.minutes(1),
  })
  try {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const worktrees = yield* Worktrees
        const acquired = yield* worktrees.acquire(task, base)
        expect(acquired.branch).toBe("agentrun/hook-hook")
        expect(() => process.kill(Number(readFileSync(survivor, "utf8")), 0)).toThrow()
        expect(journal(root)).toEqual([])
        if (worktrees.recoverProcesses) yield* worktrees.recoverProcesses
        expect(journal(root)).toEqual([])
      })).pipe(
        Effect.provide(
          Worktrees.layer({ repoRoot: root, home: root, runId: "hook", keepWorktrees: true }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    )
  } finally {
    if (existsSync(survivor)) {
      try {
        process.kill(Number(readFileSync(survivor, "utf8")), "SIGKILL")
      } catch { /* The hook child may already have exited. */ }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)

for (const probe of ["error", "invalid"]) {
  test(`a ${probe} Git group inspection keeps the leader for verified cleanup`, async () => {
    await withGit("success", async (root, diff) => {
      writeFileSync(
        join(root, "ps"),
        `#!/bin/sh
if [ "$2" = 'pid=,pgid=,stat=' ]; then
 ${probe === "error" ? "exit 23" : "echo invalid; exit 0"}
fi
exec /bin/ps "$@"
`,
        { mode: 0o755 },
      )
      const signals: string[] = []
      const kill = process.kill.bind(process)
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (
          signal !== 0 && existsSync(join(root, "leader"))
          && pid === -Number(readFileSync(join(root, "leader"), "utf8"))
        ) signals.push(String(signal))
        return kill(pid, signal)
      })
      try {
        expect(Buffer.from(await Effect.runPromise(diff))).toEqual(bytes)
        expect(signals).toEqual(["SIGTERM"])
        expect(journal(root)).toEqual([])
      } finally {
        spy.mockRestore()
      }
    })
  })
}
