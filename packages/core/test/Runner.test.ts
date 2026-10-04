import { NodeServices } from "@effect/platform-node"
import { describe, it } from "@effect/vitest"
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { vi } from "vitest"
import { Agents } from "../src/Agents.js"
import type { AgentInput } from "../src/domain/Agent.js"
import type { AgentEvent } from "../src/domain/AgentEvent.js"
import type { AgentError } from "../src/domain/Errors.js"
import type { RunEvent } from "../src/domain/RunEvent.js"
import { RunState } from "../src/domain/RunState.js"
import { Task, TaskId } from "../src/domain/Task.js"
import type { TaskStatus } from "../src/domain/TaskStatus.js"
import { RunLock } from "../src/RunLock.js"
import { Runner } from "../src/Runner.js"
import { StateStore } from "../src/StateStore.js"
import { Worktrees } from "../src/Worktrees.js"

const task = (id = "first-task") =>
  new Task({
    id: Schema.decodeSync(TaskId)(id),
    title: `Title ${id}`,
    prompt: id,
    agent: "claude-code",
    stallTimeout: Duration.minutes(5),
    maxDuration: Duration.minutes(60),
  })

const runState = (tasks: ReadonlyArray<Task>, overrides: Partial<RunState> = {}) =>
  new RunState({
    version: 1,
    runId: "20261003T1200-a1b2",
    repoRoot: "/unused",
    base: "main",
    baseSha: "unused",
    concurrency: 2,
    tasks,
    status: Object.fromEntries(tasks.map((task) => [task.id, { _tag: "pending" }])),
    worktrees: {},
    ...overrides,
  })

const fakeAgents = (
  run: (task: AgentInput) => Stream.Stream<AgentEvent, AgentError, Scope.Scope>,
  costReporting = true,
) =>
  Layer.succeed(Agents, {
    get: (id) =>
      Option.some({
        id,
        capabilities: { maxTurns: true, maxBudgetUsd: true, model: true, costReporting },
        run,
      }),
  })

const completed: AgentEvent = { _tag: "Completed", result: "Done" }
const success = Stream.fromIterable<AgentEvent>([{ _tag: "Started" }, completed])

const testLayer = (agents: Layer.Layer<Agents>, concurrency = 2) =>
  Runner.layer({ concurrency }).pipe(Layer.provideMerge(Layer.merge(agents, StateStore.layerMemory)))

const clockWorktrees = Layer.succeed(Worktrees, {
  locate: (taskId) => ({ taskId, path: "/unused", branch: "test-branch" }),
  acquire: (task) => Effect.succeed({ taskId: task.id, path: "/unused", branch: "test-branch" }),
  commit: () => Effect.succeed(false),
  diff: () => Effect.succeed(""),
  reconcile: () => Effect.succeed([]),
})

const collect = Effect.fn("test.collect")(function*(
  runner: Runner["Service"],
  observe: (event: RunEvent) => Effect.Effect<void> = () => Effect.void,
) {
  const pull = yield* Stream.toPull(runner.events.pipe(
    Stream.tap(observe),
    Stream.takeUntil((event) => event._tag === "RunFinished"),
  ))
  return yield* Effect.forkChild(Stream.runCollect(Stream.fromPull(Effect.succeed(pull))), { startImmediately: true })
})

const git = Effect.fn("test.git")(function*(cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }))
  const [stdout, stderr, exitCode] = yield* Effect.all([
    handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
    handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    handle.exitCode,
  ], { concurrency: "unbounded" })
  assert.strictEqual(exitCode, 0, `git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}, Effect.scoped)

interface Fixture {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly repoRoot: string
  readonly home: string
  readonly baseSha: string
  readonly runId: string
}

const withRepo = Effect.fn("test.withRepo")(
  function*<E, R>(
    test: (fixture: Fixture) => Effect.Effect<void, E, R>,
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-runner-repo-" })
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-runner-home-" })
    yield* git(repoRoot, ["init", "-b", "main"])
    yield* git(repoRoot, ["config", "commit.gpgsign", "false"])
    yield* fs.writeFileString(path.join(repoRoot, "tracked.txt"), "original\n")
    yield* git(repoRoot, ["add", "tracked.txt"])
    yield* git(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-m", "Initial"])
    const baseSha = yield* git(repoRoot, ["rev-parse", "main"])
    const runId = "20261003T1200-a1b2"
    yield* test({ fs, path, repoRoot, home, baseSha, runId }).pipe(
      Effect.provide(Layer.merge(Worktrees.layer({ repoRoot, home, runId }), RunLock.layer({ home }))),
    )
  },
  Effect.scoped,
  Effect.provide(NodeServices.layer),
)

describe("Runner", () => {
  it.live("limits three overlapping tasks to two agents", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const active = yield* Ref.make(0)
        const maximum = yield* Ref.make(0)
        const overlap = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const agents = fakeAgents(() =>
          Stream.fromEffect(Effect.gen(function*(): Effect.fn.Return<AgentEvent> {
            const count = yield* Ref.updateAndGet(active, (n) => n + 1)
            yield* Ref.update(maximum, (n) => Math.max(n, count))
            if (count === 2) yield* Deferred.succeed(overlap, undefined)
            return { _tag: "Started" }
          })).pipe(Stream.concat(Stream.fromEffect(Effect.gen(function*() {
            yield* Deferred.await(release)
            yield* Ref.update(active, (n) => n - 1)
            return completed
          }))))
        )
        yield* Effect.gen(function*() {
          const runner = yield* Runner
          const store = yield* StateStore
          const collector = yield* collect(runner)
          const fiber = yield* Effect.forkChild(runner.run(runState([
            task(),
            task("second-task"),
            task("third-task"),
          ], fixture)))
          yield* Deferred.await(overlap)
          assert.strictEqual(yield* Ref.get(active), 2)
          const saved = yield* store.load(fixture.runId)
          assert.deepStrictEqual(Object.values(saved.status).map((status) => status._tag).sort(), [
            "pending",
            "running",
            "running",
          ])
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(fiber)
          yield* Fiber.join(collector)
          assert.strictEqual(yield* Ref.get(maximum), 2)
          assert.strictEqual(yield* Ref.get(active), 0)
          assert.deepStrictEqual(Object.values(result.status).map((status) => status._tag), [
            "succeeded",
            "succeeded",
            "succeeded",
          ])
        }).pipe(Effect.provide(testLayer(agents)))
      })
    ))

  it.live("persists two interrupted tasks, keeps their directories and leaves one pending", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const runner = yield* Runner
        const store = yield* StateStore
        const running = yield* Ref.make(0)
        const interrupted = yield* Ref.make(0)
        const twoRunning = yield* Deferred.make<void>()
        const twoInterrupted = yield* Deferred.make<void>()
        const collector = yield* collect(runner, (event) =>
          Effect.gen(function*() {
            if (event._tag !== "TaskTransition") return
            if (event.status._tag === "running") {
              if ((yield* Ref.updateAndGet(running, (n) => n + 1)) === 2) {
                yield* Deferred.succeed(twoRunning, undefined)
              }
            } else if (event.status._tag === "interrupted") {
              if ((yield* Ref.updateAndGet(interrupted, (n) => n + 1)) === 2) {
                yield* Deferred.succeed(twoInterrupted, undefined)
              }
            }
          }))
        const initial = runState([task(), task("second-task"), task("third-task")], fixture)
        const fiber = yield* Effect.forkChild(runner.run(initial))
        yield* Deferred.await(twoRunning)
        yield* Fiber.interrupt(fiber)
        assert.strictEqual(Exit.hasInterrupts(yield* Fiber.await(fiber)), true)
        yield* Deferred.await(twoInterrupted)
        const saved = yield* store.load(initial.runId)
        assert.deepStrictEqual(Object.values(saved.status).map((status) => status._tag).sort(), [
          "interrupted",
          "interrupted",
          "pending",
        ])
        for (const task of saved.tasks) {
          if (saved.status[task.id]?._tag === "interrupted") {
            const worktree = saved.worktrees[task.id]
            assert.ok(worktree)
            assert.strictEqual(yield* fixture.fs.exists(worktree.path), true)
          }
        }
        assert.strictEqual(yield* Ref.get(interrupted), 2)
        yield* Fiber.interrupt(collector)
      }).pipe(Effect.provide(testLayer(fakeAgents(() =>
        Stream.succeed<AgentEvent>({ _tag: "Started" }).pipe(Stream.concat(Stream.never))
      ))))
    ))

  it.live("isolates agent failure and removes its clean directory while keeping the branch", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const runner = yield* Runner
        const worktrees = yield* Worktrees
        const collector = yield* collect(runner)
        const first = task()
        const result = yield* runner.run(runState([first, task("second-task")], fixture))
        const events = yield* Fiber.join(collector)
        const failed = result.status[first.id]
        assert.ok(failed?._tag === "failed")
        assert.match(failed.reason, /^AgentTaskFailed:.*boom/)
        assert.strictEqual(result.status[task("second-task").id]?._tag, "succeeded")
        const worktree = worktrees.locate(first.id)
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
        assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", worktree.branch]), fixture.baseSha)
        assert.ok(events.some((event) => event._tag === "TaskAgentEvent" && event.event._tag === "Failed"))
      }).pipe(Effect.provide(testLayer(fakeAgents((input) =>
        input.prompt === "first-task"
          ? Stream.fromIterable<AgentEvent>([{ _tag: "Started" }, { _tag: "Failed", reason: "boom" }])
          : success
      ))))
    ))

  it.live("commits new and tracked files before delivering and succeeding", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const runner = yield* Runner
        const collector = yield* collect(runner)
        const first = task()
        const result = yield* runner.run(runState([first], fixture))
        const events = yield* Fiber.join(collector)
        const deliverable = events.find((event) => event._tag === "TaskDeliverable")
        assert.ok(deliverable?._tag === "TaskDeliverable")
        assert.strictEqual(deliverable.committed, true)
        assert.ok(deliverable.diff.includes("diff --git a/new.txt b/new.txt"))
        assert.ok(deliverable.diff.includes("+new content"))
        assert.ok(deliverable.diff.includes("+tracked edit"))
        assert.ok(
          events.indexOf(deliverable)
            < events.findIndex((event) => event._tag === "TaskTransition" && event.status._tag === "succeeded"),
        )
        assert.strictEqual(result.status[first.id]?._tag, "succeeded")
        const worktree = result.worktrees[first.id]
        assert.ok(worktree)
        assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
        assert.strictEqual(
          yield* git(fixture.repoRoot, ["log", "-1", "--format=%s", worktree.branch]),
          `agentrun(${first.id}): ${first.title}`,
        )
      }).pipe(Effect.provide(testLayer(fakeAgents((input) =>
        Stream.succeed<AgentEvent>({ _tag: "Started" }).pipe(Stream.concat(
          Stream.fromEffect(
            Effect.gen(function*() {
              yield* fixture.fs.writeFileString(fixture.path.join(input.cwd, "new.txt"), "new content\n")
              yield* fixture.fs.writeFileString(fixture.path.join(input.cwd, "tracked.txt"), "tracked edit\n")
              return completed
            }).pipe(Effect.orDie),
          ),
        ))
      ))))
    ))

  it.live("persists the located worktree before creation and publication", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const runner = yield* Runner
        const store = yield* StateStore
        const worktrees = yield* Worktrees
        const observations: Array<boolean> = []
        const collector = yield* collect(runner, (event) =>
          Effect.gen(function*() {
            if (event._tag !== "TaskTransition" || event.status._tag !== "running") return
            const saved = yield* store.load(fixture.runId)
            const located = worktrees.locate(event.taskId)
            assert.deepStrictEqual(saved.worktrees[event.taskId], { path: located.path, branch: located.branch })
            assert.deepStrictEqual(saved.status[event.taskId], event.status)
            observations.push(yield* fixture.fs.exists(located.path))
          }).pipe(Effect.orDie))
        yield* runner.run(runState([task()], fixture))
        yield* Fiber.join(collector)
        assert.deepStrictEqual(observations, [false])
      }).pipe(Effect.provide(testLayer(fakeAgents(() => success))))
    ))

  it.live("sums usage costs and lets the completed total take precedence", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const runner = yield* Runner
        const collector = yield* collect(runner)
        const result = yield* runner.run(runState([task(), task("second-task")], fixture))
        const events = yield* Fiber.join(collector)
        const summed = result.status[task().id]
        const total = result.status[task("second-task").id]
        assert.ok(summed?._tag === "succeeded" && summed.costUsd !== undefined)
        assert.ok(Math.abs(summed.costUsd - 0.3) < 1e-9)
        assert.ok(total?._tag === "succeeded")
        assert.strictEqual(total.costUsd, 0.5)
        assert.strictEqual(
          events.filter((event) => event._tag === "TaskAgentEvent" && event.event._tag === "Usage").length,
          4,
        )
      }).pipe(Effect.provide(testLayer(fakeAgents((input) =>
        Stream.fromIterable<AgentEvent>([
          { _tag: "Started" },
          { _tag: "Usage", inputTokens: 1, outputTokens: 2, costUsd: 0.1 },
          { _tag: "Usage", inputTokens: 3, outputTokens: 4, costUsd: 0.2 },
          input.prompt === "first-task" ? completed : { ...completed, costUsd: 0.5 },
        ])
      ))))
    ))

  it.effect("measures duration with the test clock", () =>
    Effect.gen(function*() {
      const runner = yield* Runner
      const collector = yield* collect(runner)
      const result = yield* runner.run(runState([task()]))
      yield* Fiber.join(collector)
      assert.deepStrictEqual(result.status[task().id], { _tag: "succeeded", durationMs: 90000, costUsd: 0 })
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(fakeAgents(() =>
          Stream.succeed<AgentEvent>({ _tag: "Started" }).pipe(Stream.concat(
            Stream.fromEffect(TestClock.adjust("90 seconds").pipe(Effect.as(completed))),
          ))
        )).pipe(Layer.provide(Layer.mergeAll(
          clockWorktrees,
          Layer.succeed(RunLock, { acquire: () => Effect.void }),
          NodeServices.layer,
        ))),
      ),
    ))

  it.live("fails setup before calling the agent and removes the directory", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        let calls = 0
        yield* Effect.gen(function*() {
          const runner = yield* Runner
          const collector = yield* collect(runner)
          const result = yield* runner.run(runState([task()], { ...fixture, setup: "sh -c 'exit 3'" }))
          yield* Fiber.join(collector)
          const status = result.status[task().id]
          assert.ok(status?._tag === "failed")
          assert.match(status.reason, /^SetupError:/)
          assert.ok(status.reason.includes("3"))
          assert.strictEqual(calls, 0)
          const worktree = result.worktrees[task().id]
          assert.ok(worktree)
          assert.strictEqual(yield* fixture.fs.exists(worktree.path), false)
        }).pipe(Effect.provide(testLayer(fakeAgents(() => {
          calls++
          return success
        }))))
      })
    ))

  it.live("leaves terminal tasks unchanged on a second run", () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const calls = yield* Ref.make(0)
        yield* Effect.gen(function*() {
          const runner = yield* Runner
          const firstCollector = yield* collect(runner)
          const first = yield* runner.run(runState([task()], fixture))
          yield* Fiber.join(firstCollector)
          const secondCollector = yield* collect(runner)
          const second = yield* runner.run(first)
          const events = yield* Fiber.join(secondCollector)
          assert.deepStrictEqual(second, first)
          assert.strictEqual(yield* Ref.get(calls), 1)
          assert.deepStrictEqual(events, [{ _tag: "RunFinished", runId: first.runId }])
        }).pipe(Effect.provide(testLayer(fakeAgents(() =>
          Stream.fromEffect(Ref.update(calls, (n) => n + 1)).pipe(Stream.flatMap(() => success))
        ))))
      })
    ))

  it.effect("reports unknown runs and tracks the last saved id in memory", () =>
    Effect.gen(function*() {
      const store = yield* StateStore
      assert.deepStrictEqual(yield* store.latest, Option.none())
      const error = yield* Effect.flip(store.load("unknown"))
      assert.strictEqual(error._tag, "RunNotFound")
      if (error._tag === "RunNotFound") assert.strictEqual(error.runId, "unknown")
      const first = runState([task()])
      const second = runState([task()], { runId: "second-run" })
      yield* store.save(first)
      yield* store.save(second)
      assert.deepStrictEqual(yield* store.latest, Option.some(second.runId))
      assert.deepStrictEqual(yield* store.load(first.runId), first)
      assert.deepStrictEqual(yield* store.load(second.runId), second)
      yield* store.save(first)
      assert.deepStrictEqual(yield* store.latest, Option.some(first.runId))
    }).pipe(Effect.provide(StateStore.layerMemory)))
})

it.live("resumes two interrupted tasks in the same directories and branches", () =>
  withRepo((fixture) =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const count = yield* Ref.make(0)
      const storeLayer = StateStore.layerMemory
      const blocked = fakeAgents(() =>
        Stream.fromEffect(Effect.gen(function*(): Effect.fn.Return<AgentEvent> {
          if ((yield* Ref.updateAndGet(count, (n) => n + 1)) === 2) yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }))
      )
      yield* Effect.gen(function*() {
        const store = yield* StateStore
        const initial = runState([task(), task("second-task")], fixture)
        yield* Effect.gen(function*() {
          const fiber = yield* Effect.forkChild((yield* Runner).run(initial))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(Runner.layer({ concurrency: 2 }).pipe(Layer.provide(blocked))))
        const saved = yield* store.load(initial.runId)
        yield* Effect.gen(function*() {
          const runner = yield* Runner
          const collector = yield* collect(runner)
          const result = yield* runner.run(saved)
          const events = yield* Fiber.join(collector)
          assert.deepStrictEqual(result.worktrees, saved.worktrees)
          for (const task of result.tasks) {
            assert.strictEqual(result.status[task.id]?._tag, "succeeded")
            assert.ok(events.some((event) =>
              event._tag === "TaskTransition" && event.taskId === task.id && event.status._tag === "running"
              && event.status.attempt === 2
            ))
          }
        }).pipe(Effect.provide(
          Runner.layer({ concurrency: 2 }).pipe(Layer.provide(fakeAgents(() =>
            success
          ))),
        ))
      }).pipe(Effect.provide(storeLayer))
    })
  ))
for (const mode of ["recreated", "crashed", "missing", "failed", "retry"]) {
  it.live(`resumes ${mode} state`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const worktrees = yield* Worktrees
        const located = worktrees.locate(task().id)
        if (mode === "recreated" || mode === "crashed" || mode === "missing") {
          yield* fixture.fs.makeDirectory(fixture.path.dirname(located.path), { recursive: true })
          yield* git(fixture.repoRoot, ["worktree", "add", "-b", located.branch, located.path, fixture.baseSha])
          if (mode !== "crashed") yield* fixture.fs.remove(located.path, { recursive: true })
        }
        const status: TaskStatus = mode === "recreated"
          ? { _tag: "interrupted", attempt: 1 }
          : mode === "crashed" || mode === "missing"
          ? { _tag: "running", attempt: 1, startedAt: yield* DateTime.now }
          : { _tag: "failed", attempt: 1, reason: "old failure" }
        const initial = runState([task()], {
          ...fixture,
          status: { [task().id]: status },
          worktrees: { [task().id]: located },
        })
        let calls = 0
        yield* Effect.gen(function*() {
          const runner = yield* Runner
          const collector = yield* collect(runner)
          const result = yield* runner.run(initial)
          const events = yield* Fiber.join(collector)
          if (mode === "missing" || mode === "failed") {
            assert.strictEqual(calls, 0)
            assert.deepStrictEqual(result.status[task().id], {
              _tag: "failed",
              attempt: 1,
              reason: mode === "missing" ? "worktree missing" : "old failure",
            })
          } else {
            assert.strictEqual(calls, 1)
            assert.strictEqual(result.status[task().id]?._tag, "succeeded")
            assert.ok(
              events.some((event) =>
                event._tag === "TaskTransition" && event.status._tag === "running" && event.status.attempt === 2
              ),
            )
            if (mode === "crashed") {
              assert.ok(events.some((event) => event._tag === "TaskTransition" && event.status._tag === "interrupted"))
            }
          }
        }).pipe(
          Effect.provide(
            Runner.layer({ concurrency: 1, retryFailed: mode === "retry" }).pipe(
              Layer.provide(Layer.merge(
                fakeAgents(() => {
                  calls++
                  return success
                }),
                StateStore.layerMemory,
              )),
            ),
          ),
        )
      })
    ))
}
it.live("rejects a held repository lock before transitions", () =>
  withRepo((fixture) =>
    Effect.scoped(Effect.gen(function*() {
      yield* (yield* RunLock).acquire(fixture.repoRoot)
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const store = yield* StateStore
        const error = yield* Effect.flip(runner.run(runState([task()], fixture)))
        assert.strictEqual(error._tag, "RunLocked")
        assert.deepStrictEqual(yield* store.latest, Option.none())
      }).pipe(Effect.provide(testLayer(fakeAgents(() => success))))
    }))
  ))

for (const code of ["ESRCH", "EPERM", "live", "invalid"]) {
  it.live(`checks saved process-group ${code} without termination signals`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const located = (yield* Worktrees).locate(task().id)
        yield* fixture.fs.makeDirectory(fixture.path.dirname(located.path), { recursive: true })
        yield* git(fixture.repoRoot, ["worktree", "add", "-b", located.branch, located.path, fixture.baseSha])
        const initial = runState([task()], {
          ...fixture,
          status: { [task().id]: { _tag: "running", attempt: 1, startedAt: yield* DateTime.now } },
          worktrees: { [task().id]: { ...located, pgid: code === "invalid" ? 0 : 999999 } },
        })
        let calls = 0
        const signals: Array<[number, string | number | undefined]> = []
        const kill = process.kill.bind(process)
        const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid !== -999999) return kill(pid, signal)
          signals.push([pid, signal])
          if (code === "live") return true
          throw Object.assign(new Error(code), { code })
        })
        yield* Effect.gen(function*() {
          const runner = yield* Runner
          const store = yield* StateStore
          yield* store.save(initial)
          const result = yield* Effect.result(runner.run(initial))
          if (code === "ESRCH") {
            assert.ok(result._tag === "Success")
            assert.strictEqual(calls, 1)
          } else {
            assert.ok(result._tag === "Failure")
            assert.strictEqual(result.failure._tag, "GitError")
            assert.strictEqual(calls, 0)
            assert.deepStrictEqual(yield* store.load(initial.runId), initial)
          }
          assert.deepStrictEqual(signals, code === "invalid" ? [] : [[-999999, 0]])
        }).pipe(
          Effect.provide(testLayer(fakeAgents(() => {
            calls++
            return success
          }))),
          Effect.ensuring(Effect.sync(() => spy.mockRestore())),
        )
      })
    ))
}

for (const status of ["running", "interrupted", "pending", "failed", "succeeded"] as const) {
  it.live(`preserves a live saved group and worktree for ${status} state`, () =>
    withRepo((fixture) =>
      Effect.gen(function*() {
        const child = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const child = spawn(process.execPath, [
              "-e",
              "process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000); process.stdout.write(\"ready\")",
            ], {
              detached: true,
              stdio: ["ignore", "pipe", "inherit"],
            })
            await once(child.stdout, "data")
            return child
          }),
          (child) =>
            Effect.promise(async () => {
              const closed = once(child, "close")
              child.kill("SIGKILL")
              await closed
            }),
        )
        assert.ok(child.pid !== undefined)
        const pgid = child.pid
        const located = (yield* Worktrees).locate(task().id)
        yield* fixture.fs.makeDirectory(fixture.path.dirname(located.path), { recursive: true })
        yield* git(fixture.repoRoot, ["worktree", "add", "-b", located.branch, located.path, fixture.baseSha])
        const initial = runState([task()], {
          ...fixture,
          status: {
            [task().id]: status === "running"
              ? { _tag: status, attempt: 1, startedAt: yield* DateTime.now }
              : status === "interrupted"
              ? { _tag: status, attempt: 1 }
              : status === "failed"
              ? { _tag: status, attempt: 1, reason: "previous failure" }
              : status === "succeeded"
              ? { _tag: status, durationMs: 1 }
              : { _tag: status },
          },
          worktrees: { [task().id]: { ...located, pgid } },
        })
        let launches = 0
        yield* Effect.gen(function*() {
          const store = yield* StateStore
          yield* store.save(initial)
          const result = yield* Effect.result((yield* Runner).run(yield* store.load(initial.runId)))
          assert.strictEqual(launches, 0, "replacement must not start while the saved group is live")
          assert.ok(result._tag === "Failure", "live saved group must block reconciliation")
          assert.strictEqual(result.failure._tag, "GitError")
          assert.deepStrictEqual(yield* store.load(initial.runId), initial)
          assert.ok(yield* fixture.fs.exists(located.path), "live group's worktree must remain")
          assert.strictEqual(yield* git(fixture.repoRoot, ["rev-parse", located.branch]), fixture.baseSha)
          assert.ok(process.kill(-pgid, 0), "unverified saved group must remain alive")
        }).pipe(Effect.provide(
          Runner.layer({ concurrency: 1, retryFailed: true }).pipe(Layer.provideMerge(Layer.merge(
            fakeAgents(() => {
              launches++
              return success
            }),
            StateStore.layerFile({ repoRoot: fixture.repoRoot }),
          ))),
        ))
      })
    ))
}
