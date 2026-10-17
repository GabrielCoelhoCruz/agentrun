import { NodeServices } from "@effect/platform-node"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { expect, test, vi } from "vitest"
import { TaskId } from "../src/domain/Task.js"
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
  writeFileSync(join(root, "ps"), `#!/bin/sh\necho scan >> '${root}/scans'\nexec /bin/ps "$@"\n`, { mode: 0o755 })
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
  test(`completed Git ${mode} exits without process-table scans or signals`, async () => {
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

test("a surviving Git child without its leader refuses cleanup without signals", async () => {
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
      expect(Exit.isFailure(result)).toBe(true)
      expect(inspect(result, { depth: 10 })).toContain("Process group ownership changed; recovery refused")
      expect(signals).toEqual([])
      expect(journal(root)).toHaveLength(1)
      expect(() => process.kill(Number(readFileSync(join(root, "survivor"), "utf8")), 0)).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
}, 60000)
