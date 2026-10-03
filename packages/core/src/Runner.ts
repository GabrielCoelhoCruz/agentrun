import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect"
import type { Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Agents } from "./Agents.js"
import type { AgentEvent } from "./domain/AgentEvent.js"
import { AgentSpawnError, AgentTaskFailed, GitError, SetupError } from "./domain/Errors.js"
import type { RunnerError, TaskError } from "./domain/Errors.js"
import type { RunEvent } from "./domain/RunEvent.js"
import { RunState } from "./domain/RunState.js"
import type { Task, TaskId } from "./domain/Task.js"
import type { TaskStatus } from "./domain/TaskStatus.js"
import { stopProcessGroup } from "./ProcessGroup.js"
import { RunLock } from "./RunLock.js"
import { StateStore } from "./StateStore.js"
import { Worktrees } from "./Worktrees.js"

interface Options {
  readonly loadProjectSettings?: boolean
  readonly setupInAgent?: boolean
  readonly concurrency: number
  readonly retryFailed?: boolean
}

export class Runner extends Context.Service<Runner, {
  readonly run: (state: RunState) => Effect.Effect<RunState, RunnerError>
  readonly subscribe: Effect.Effect<Stream.Stream<RunEvent>, never, Scope.Scope>
  readonly events: Stream.Stream<RunEvent>
}>()("agentrun/Runner") {
  static readonly layer = (options: Options) => Layer.effect(Runner, make(options))
}

const isTaskError = (error: TaskError | PlatformError): error is TaskError =>
  error._tag === "GitError" || error._tag === "SetupError" || error._tag === "AgentSpawnError"
  || error._tag === "AgentCrashed" || error._tag === "AgentProtocolError" || error._tag === "AgentTaskFailed"
  || error._tag === "AgentStalled" || error._tag === "AgentTimedOut"

const detail = (error: TaskError): string => {
  switch (error._tag) {
    case "SetupError":
      return `Task ${error.taskId}: ${error.command} exited ${error.exitCode}: ${error.stderr}`
    case "GitError":
      return `${error.command} exited ${error.exitCode}: ${error.stderr}`
    case "AgentSpawnError":
      return String(error.cause)
    case "AgentCrashed":
      return `${error.agent} exited ${error.exitCode}`
    case "AgentProtocolError":
      return error.issue
    case "AgentTaskFailed":
      return error.reason
    case "AgentStalled":
      return `No events for ${Duration.toMillis(error.idleFor)}ms`
    case "AgentTimedOut":
      return `Exceeded ${Duration.toMillis(error.after)}ms`
  }
}

const make = Effect.fn("Runner.make")(function*(options: Options) {
  const worktrees = yield* Worktrees
  const agents = yield* Agents
  const store = yield* StateStore
  const lock = yield* RunLock
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const semaphore = yield* Semaphore.make(options.concurrency)
  const pubsub = yield* PubSub.unbounded<RunEvent>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

  const setup = Effect.fn("Runner.setup")(function*(taskId: TaskId, command: string, cwd: string) {
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", command], { cwd }))
    const [, stderr, exitCode] = yield* Effect.all([
      Stream.runDrain(handle.stdout),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) return yield* new SetupError({ taskId, command, exitCode, stderr })
  }, (effect, taskId, command) =>
    effect.pipe(
      Effect.mapError((error) =>
        error._tag === "SetupError"
          ? error
          : new SetupError({ taskId, command, exitCode: -1, stderr: error.message })
      ),
      Effect.scoped,
    ))

  const run = Effect.fn("Runner.run")(
    function*(state: RunState): Effect.fn.Return<RunState, RunnerError, Scope.Scope> {
      yield* lock.acquire(state.repoRoot)
      const current = yield* SynchronizedRef.make(state)

      const transition = Effect.fn("Runner.transition")(function*(taskId: TaskId, status: TaskStatus) {
        yield* SynchronizedRef.updateEffect(current, (previous) =>
          Effect.gen(function*() {
            const from = previous.status[taskId]?._tag
            const to = status._tag
            const allowed = to === "running"
              ? from === "pending" || from === "interrupted" || from === "failed"
              : from === "running" && (to === "succeeded" || to === "failed" || to === "interrupted")
            if (!allowed) return yield* Effect.die(`Invalid task transition for ${taskId}: ${from} -> ${to}`)
            const located = worktrees.locate(taskId)
            const next = new RunState({
              ...previous,
              status: { ...previous.status, [taskId]: status },
              worktrees: to === "running"
                ? {
                  ...previous.worktrees,
                  [taskId]: previous.worktrees[taskId] ?? { path: located.path, branch: located.branch },
                }
                : (to === "succeeded" || to === "failed") && previous.worktrees[taskId] !== undefined
                ? { ...previous.worktrees, [taskId]: { path: located.path, branch: located.branch } }
                : previous.worktrees,
            })
            yield* store.save(next)
            return next
          }))
        yield* PubSub.publish(pubsub, { _tag: "TaskTransition", taskId, status })
      }, Effect.uninterruptible)

      for (const task of state.tasks) {
        const recorded = state.worktrees[task.id]
        const located = worktrees.locate(task.id)
        if (recorded !== undefined && (recorded.path !== located.path || recorded.branch !== located.branch)) {
          return yield* new GitError({
            command: "resume identity",
            exitCode: -1,
            stderr: `Recorded worktree identity differs for ${task.id}`,
          })
        }
      }
      for (const recorded of Object.values(state.worktrees)) {
        if (recorded.pgid !== undefined) yield* stopProcessGroup(recorded.pgid, recorded.processToken)
      }
      const reconciled = yield* worktrees.reconcile(state)
      for (const action of reconciled) {
        const status = (yield* SynchronizedRef.get(current)).status[action.taskId]
        if (action._tag === "Interrupted" && status?._tag === "running") {
          yield* transition(action.taskId, { _tag: "interrupted", attempt: status.attempt })
        } else if (action._tag === "WorktreeMissing" && status?._tag === "running") {
          yield* transition(
            action.taskId,
            { _tag: "failed", attempt: status.attempt, reason: "worktree missing" },
          )
        } else if (action._tag === "RemoveFailed") {
          yield* PubSub.publish(pubsub, { _tag: "TaskWarning", taskId: action.taskId, message: action.stderr })
        }
      }

      const runTask = Effect.fn("Runner.runTask")(
        function*(task: Task): Effect.fn.Return<void, TaskError | PlatformError> {
          const startedAt = yield* DateTime.now
          const start = yield* Clock.currentTimeMillis
          const previous = (yield* SynchronizedRef.get(current)).status[task.id]
          const attempt = previous?._tag === "interrupted" || previous?._tag === "failed" ? previous.attempt + 1 : 1
          yield* transition(task.id, { _tag: "running", attempt, startedAt })
          const costUsd = yield* Effect.scoped(Effect.gen(function*() {
            const worktree = yield* worktrees.acquire(task, state.baseSha)
            if (state.setup !== undefined && !options.setupInAgent) yield* setup(task.id, state.setup, worktree.path)
            const adapter = agents.get(task.agent)
            if (Option.isNone(adapter)) {
              return yield* Effect.die(`Missing agent adapter: ${task.agent} for task ${task.id}`)
            }
            const summary = yield* adapter.value.run({
              taskId: task.id,
              loadProjectSettings: options.loadProjectSettings === true,
              ...(options.setupInAgent && state.setup !== undefined ? { setup: state.setup } : {}),
              registerProcess: (pgid, processToken) =>
                SynchronizedRef.updateEffect(current, (previous) => {
                  const located = worktrees.locate(task.id)
                  const next = new RunState({
                    ...previous,
                    worktrees: {
                      ...previous.worktrees,
                      [task.id]: { ...located, pgid, processToken },
                    },
                  })
                  return store.save(next).pipe(Effect.as(next))
                }).pipe(Effect.mapError((cause) => new AgentSpawnError({ agent: task.agent, cause }))),
              prompt: task.prompt,
              cwd: worktree.path,
              model: Option.fromUndefinedOr(task.model),
              maxTurns: Option.fromUndefinedOr(task.maxTurns),
              maxBudgetUsd: Option.fromUndefinedOr(task.maxBudgetUsd),
            }).pipe(Stream.runFoldEffect(
              (): { readonly last: Option.Option<AgentEvent>; readonly costUsd: number } => ({
                last: Option.none(),
                costUsd: 0,
              }),
              (summary, event) =>
                Effect.gen(function*() {
                  yield* PubSub.publish(pubsub, { _tag: "TaskAgentEvent", taskId: task.id, event })
                  if (event._tag === "Failed") {
                    return yield* new AgentTaskFailed({ agent: task.agent, reason: event.reason })
                  }
                  return {
                    last: Option.some(event),
                    costUsd: summary.costUsd + (event._tag === "Usage" ? event.costUsd ?? 0 : 0),
                  }
                }),
            ))
            if (Option.isNone(summary.last) || summary.last.value._tag !== "Completed") {
              return yield* Effect.die(`Adapter ${task.agent} ended the stream without Completed or Failed`)
            }
            const committed = yield* worktrees.commit(worktree, `agentrun(${task.id}): ${task.title}`)
            const diff = yield* worktrees.diff(worktree, state.baseSha)
            yield* PubSub.publish(pubsub, {
              _tag: "TaskDeliverable",
              taskId: task.id,
              branch: worktree.branch,
              committed,
              diff,
            })
            return summary.last.value.costUsd
              ?? (adapter.value.capabilities.costReporting ? summary.costUsd : undefined)
          })).pipe(Effect.onExit((exit) =>
            Effect.gen(function*() {
              if (Exit.hasInterrupts(exit)) return
              const located = worktrees.locate(task.id)
              if (yield* fs.exists(located.path).pipe(Effect.orDie)) {
                yield* PubSub.publish(pubsub, {
                  _tag: "TaskWarning",
                  taskId: task.id,
                  message: `Worktree kept at ${located.path}`,
                })
              }
            })
          ))
          const durationMs = (yield* Clock.currentTimeMillis) - start
          yield* transition(task.id, {
            _tag: "succeeded",
            durationMs,
            ...(costUsd === undefined ? {} : { costUsd }),
          })
        },
        (effect, task) =>
          effect.pipe(
            Effect.catchIf(
              isTaskError,
              (error) =>
                Effect.gen(function*() {
                  const status = (yield* SynchronizedRef.get(current)).status[task.id]
                  if (status?._tag === "running") {
                    yield* transition(task.id, {
                      _tag: "failed",
                      attempt: status.attempt,
                      reason: `${error._tag}: ${detail(error)}`,
                    })
                  }
                }),
            ),
            Effect.onExit((exit) =>
              Effect.gen(function*() {
                if (!Exit.hasInterrupts(exit)) {
                  return
                }
                const status = (yield* SynchronizedRef.get(current)).status[task.id]
                if (status?._tag === "running") {
                  yield* transition(task.id, { _tag: "interrupted", attempt: status.attempt })
                }
              }).pipe(Effect.uninterruptible)
            ),
            semaphore.withPermits(1),
          ),
      )

      const reconciledState = yield* SynchronizedRef.get(current)
      const pendingTasks = state.tasks.filter((task) => {
        const status = reconciledState.status[task.id]?._tag
        return status === "pending" || status === "interrupted"
          || (options.retryFailed === true && status === "failed")
      })
      yield* Effect.forEach(pendingTasks, runTask, { concurrency: "unbounded" })
      return yield* SynchronizedRef.get(current)
    },
    (effect, state) =>
      effect.pipe(
        Effect.onExit(() => PubSub.publish(pubsub, { _tag: "RunFinished", runId: state.runId })),
        Effect.scoped,
      ),
  )

  return Runner.of({
    run,
    subscribe: PubSub.subscribe(pubsub).pipe(
      Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
    ),
    events: Stream.fromPubSub(pubsub),
  })
})
