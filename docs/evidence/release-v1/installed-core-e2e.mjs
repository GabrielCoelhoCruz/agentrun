import { Agents, Report, RunLock, Runner, RunState, StateStore, TaskFile, version, Worktrees } from "@agentrun/core"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option, Stream } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
assert.equal(version, "0.1.0")
const repo = realpathSync(process.argv[2])
const home = realpathSync(process.argv[3])
let calls = 0
const capabilities = { maxTurns: true, maxBudgetUsd: true, model: true, costReporting: true }
const adapter = {
  id: "claude-code",
  capabilities,
  run: input =>
    Stream.concat(
      Stream.make({ _tag: "Started", sessionId: "synthetic-consumer" }, {
        _tag: "ToolCall",
        id: "synthetic-write",
        name: "write",
        input: {},
      }),
      Stream.fromEffect(Effect.sync(() => {
        calls++
        writeFileSync(join(input.cwd, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
        writeFileSync(join(input.cwd, "binary.dat"), Buffer.from([0, 0xff, 0x0a, 0x10]))
        return { _tag: "Completed", result: "synthetic bytes saved", costUsd: 0, turns: 1 }
      })),
    ),
}
const services = Layer.mergeAll(
  Layer.succeed(Agents, { get: () => Option.some(adapter) }),
  StateStore.layerFile({ repoRoot: repo }),
  Worktrees.layer({ repoRoot: repo, runId: "consumer-demo", home }),
  RunLock.layer({ home }),
  Report.layer,
)
const live = Runner.layer({ concurrency: 1 }).pipe(Layer.provideMerge(services), Layer.provide(NodeServices.layer))
const program = Effect.gen(function*() {
  const parsed = yield* TaskFile.parse({
    path: "TASKS.md",
    content: "## bytes: Preserve exact bytes\nWrite deterministic files.\n",
    capabilities: { "claude-code": capabilities, pi: { ...capabilities, maxTurns: false, maxBudgetUsd: false } },
  })
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  const state = new RunState({
    version: 1,
    runId: "consumer-demo",
    repoRoot: repo,
    base: "HEAD",
    baseSha,
    concurrency: 1,
    tasks: parsed.tasks,
    status: { bytes: { _tag: "pending" } },
    worktrees: {},
  })
  yield* (yield* StateStore).save(state)
  const final = yield* (yield* Runner).run(state)
  assert.equal(final.status.bytes._tag, "succeeded")
  assert.equal(calls, 1)
  console.log(JSON.stringify({ calls, status: final.status, version, baseSha }))
})
await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(live))))
