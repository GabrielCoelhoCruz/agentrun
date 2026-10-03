import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { DateTime, Duration, Effect, FileSystem, Option, Path, Schema } from "effect"
import assert from "node:assert/strict"
import { RunState } from "../src/domain/RunState.js"
import { Task, TaskId } from "../src/domain/Task.js"
import { StateStore } from "../src/StateStore.js"

const id = Schema.decodeSync(TaskId)("task")
const state = (repoRoot: string, runId = "20260101T0000-aaaa") =>
  new RunState({
    version: 1,
    repoRoot,
    runId,
    base: "main",
    baseSha: "sha",
    concurrency: 1,
    tasks: [
      new Task({
        id,
        title: "Task",
        prompt: "Work",
        agent: "claude-code",
        stallTimeout: Duration.minutes(5),
        maxDuration: Duration.hours(1),
      }),
    ],
    status: { [id]: { _tag: "running", attempt: 1, startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") } },
    worktrees: {},
  })
const testFile = Effect.fn("test.file")(
  function*<E, R>(test: (repoRoot: string) => Effect.Effect<void, E, R>) {
    const fs = yield* FileSystem.FileSystem
    const repoRoot = yield* fs.makeTempDirectoryScoped()
    yield* test(repoRoot).pipe(Effect.provide(StateStore.layerFile({ repoRoot })))
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
)

it.live("saves and decodes dates and durations", () =>
  testFile((repoRoot) =>
    Effect.gen(function*() {
      const store = yield* StateStore
      const fs = yield* FileSystem.FileSystem
      const saved = state(repoRoot)
      yield* store.save(saved)
      assert.ok(yield* fs.exists(`${repoRoot}/.agentrun/runs/${saved.runId}/state.json`))
      assert.deepStrictEqual(yield* store.load(saved.runId), saved)
    })
  ))
it.live("reports an unknown id", () =>
  testFile(() =>
    Effect.gen(function*() {
      assert.strictEqual((yield* Effect.flip((yield* StateStore).load("unknown")))._tag, "RunNotFound")
    })
  ))
for (const content of ["{\"version\":2}", "{broken"]) {
  it.live(`reports corrupt state ${content}`, () =>
    testFile((repoRoot) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const file = path.join(repoRoot, ".agentrun", "runs", "broken", "state.json")
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.writeFileString(file, content)
        const error = yield* Effect.flip((yield* StateStore).load("broken"))
        assert.ok(error._tag === "StateCorrupted")
        assert.strictEqual(error.path, file)
      })
    ))
}
it.live("finds the greatest saved id and ignores incomplete runs", () =>
  testFile((repoRoot) =>
    Effect.gen(function*() {
      const store = yield* StateStore
      const fs = yield* FileSystem.FileSystem
      assert.deepStrictEqual(yield* store.latest, Option.none())
      for (const id of ["20260101T0000-aaaa", "20260102T0000-bbbb", "20260101T1200-cccc"]) {
        yield* store.save(state(repoRoot, id))
      }
      yield* fs.makeDirectory(`${repoRoot}/.agentrun/runs/zzzz`, { recursive: true })
      assert.deepStrictEqual(yield* store.latest, Option.some("20260102T0000-bbbb"))
    })
  ))
it.live("ignores a partial temporary write", () =>
  testFile((repoRoot) =>
    Effect.gen(function*() {
      const store = yield* StateStore
      const saved = state(repoRoot)
      yield* store.save(saved)
      yield* (yield* FileSystem.FileSystem).writeFileString(
        `${repoRoot}/.agentrun/runs/${saved.runId}/state.json.tmp`,
        "garbage",
      )
      assert.deepStrictEqual(yield* store.load(saved.runId), saved)
    })
  ))
