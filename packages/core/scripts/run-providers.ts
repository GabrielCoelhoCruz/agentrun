import {
  Agents,
  ClaudeCode,
  Pi,
  Report,
  RunLock,
  Runner,
  RunState,
  StateStore,
  TaskFile,
  Worktrees,
} from "@agentrun/core"
import { createAgentSession } from "@earendil-works/pi-coding-agent"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { appendFileSync } from "node:fs"

const git = Effect.fn("integration.git")(function*(cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }))
  const [stdout, stderr, code] = yield* Effect.all([
    handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
    handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    handle.exitCode,
  ], { concurrency: "unbounded" })
  if (code !== 0) return yield* Effect.die(`git ${args.join(" ")} exited ${code}: ${stderr}`)
  return stdout.trim()
}, Effect.scoped)

const content = `---
base: main
concurrency: 1
---
## claude-task: Claude file
agent: claude-code
maxTurns: 3
maxBudgetUsd: 0.25

Write claude-result.txt containing exactly "claude-ok" using the Write tool. Do not run other tools. Reply done.

## pi-task: Pi file
agent: pi
model: openai/gpt-6-astra

Write pi-result.txt containing exactly "pi-ok" using the write tool. Do not run other tools. Reply done.
`

const program = Effect.gen(function*() {
  const argument = process.argv[2]
  if (!argument) return yield* Effect.die("Usage: node scripts/run-providers.ts <private-output-directory>")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const output = path.resolve(argument)
  const repoRoot = path.join(output, "repo")
  const home = path.join(output, "home")
  if (yield* fs.exists(repoRoot)) return yield* Effect.die("Output repo already exists; use a fresh directory")
  yield* fs.makeDirectory(output, { recursive: true, mode: 0o700 })
  yield* fs.makeDirectory(repoRoot)
  yield* fs.makeDirectory(home)
  yield* fs.writeFileString(path.join(output, "owner.json"), JSON.stringify({ pid: process.pid, repoRoot, home }))
  yield* fs.writeFileString(path.join(repoRoot, "TASKS.md"), content)
  yield* fs.writeFileString(path.join(repoRoot, ".gitignore"), ".agentrun/\n")
  yield* git(repoRoot, ["init", "-b", "main"])
  yield* git(repoRoot, ["config", "commit.gpgsign", "false"])
  yield* git(repoRoot, ["config", "user.name", "Integration Test"])
  yield* git(repoRoot, ["config", "user.email", "test@example.invalid"])
  yield* git(repoRoot, ["add", "TASKS.md", ".gitignore"])
  yield* git(repoRoot, ["commit", "-m", "test: prepare provider tasks"])
  const baseSha = yield* git(repoRoot, ["rev-parse", "main"])
  const runId = "step7-providers-test"
  const pi = Pi.make({
    createAgentSession: (options) =>
      createAgentSession(options).then(({ session }) => ({
        session: {
          sessionId: session.sessionId,
          subscribe: (listener) =>
            session.subscribe((event) => {
              appendFileSync(path.join(output, "pi-sdk.private.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 })
              listener(event)
            }),
          prompt: (prompt) => session.prompt(prompt),
          abort: () => session.abort(),
          dispose: () => session.dispose(),
        },
      })),
  })
  const agents = Layer.succeed(Agents, { get: (id) => Option.some(id === "pi" ? pi : ClaudeCode.adapter) })
  const tasks = yield* TaskFile.parse({
    path: "TASKS.md",
    content,
    capabilities: { pi: pi.capabilities, "claude-code": ClaudeCode.adapter.capabilities },
  })
  const initial = new RunState({
    version: 1,
    runId,
    repoRoot,
    base: tasks.base,
    baseSha,
    concurrency: tasks.concurrency,
    tasks: tasks.tasks,
    status: Object.fromEntries(tasks.tasks.map((task) => [task.id, { _tag: "pending" }])),
    worktrees: {},
  })
  const dependencies = Layer.mergeAll(
    Report.layer,
    agents,
    Worktrees.layer({ repoRoot, home, runId }),
    RunLock.layer({ home }),
    StateStore.layerFile({ repoRoot }),
  )
  yield* Effect.gen(function*() {
    const runner = yield* Runner
    const store = yield* StateStore
    const pull = yield* Stream.toPull(runner.events.pipe(
      Stream.takeUntil((event) => event._tag === "RunFinished"),
      Stream.tap((event) =>
        Effect.sync(() => {
          appendFileSync(path.join(output, "run-events.private.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 })
        })
      ),
    ))
    yield* Effect.forkChild(Stream.runDrain(Stream.fromPull(Effect.succeed(pull))), { startImmediately: true })
    const final = yield* runner.run(initial).pipe(Effect.timeout("90 seconds"))
    const saved = yield* store.load(runId)
    yield* fs.writeFileString(path.join(output, "result.private.json"), JSON.stringify({ final, saved }, null, 2))
    for (const task of tasks.tasks) {
      const worktree = final.worktrees[task.id]
      if (worktree === undefined) return yield* Effect.die(`Missing worktree metadata for ${task.id}`)
      const file = task.agent === "pi" ? "pi-result.txt" : "claude-result.txt"
      if (final.status[task.id]?._tag === "succeeded") {
        const actual = yield* git(repoRoot, ["show", `${worktree.branch}:${file}`])
        const expected = task.agent === "pi" ? "pi-ok" : "claude-ok"
        if (actual !== expected) return yield* Effect.die(`Wrong file content for ${task.id}`)
        if (yield* fs.exists(worktree.path)) return yield* Effect.die(`Worktree remains for ${task.id}`)
      }
    }
    yield* Effect.sync(() =>
      console.log(JSON.stringify({
        tasks: Object.fromEntries(Object.entries(final.status).map(([id, status]) => [id, status._tag])),
        verifiedFiles: tasks.tasks.filter((task) => final.status[task.id]?._tag === "succeeded").length,
      }))
    )
    if (tasks.tasks.some((task) => final.status[task.id]?._tag !== "succeeded")) {
      return yield* Effect.die("A provider task failed; inspect private run output")
    }
  }).pipe(
    Effect.provide(Runner.layer({ concurrency: 1 }).pipe(Layer.provideMerge(dependencies))),
  )
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
