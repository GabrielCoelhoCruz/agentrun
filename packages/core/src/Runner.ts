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
  Schedule,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect"
import type { Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createHash } from "node:crypto"
import { Agents } from "./Agents.js"
import type { AgentEvent } from "./domain/AgentEvent.js"
import {
  AgentSpawnError,
  AgentStalled,
  AgentTaskFailed,
  AgentTimedOut,
  GitError,
  ReportError,
  retryableSpawnError,
  SetupError,
} from "./domain/Errors.js"
import type { RunnerError, TaskError } from "./domain/Errors.js"
import type { RunEvent } from "./domain/RunEvent.js"
import { RunState } from "./domain/RunState.js"
import type { Task, TaskId } from "./domain/Task.js"
import type { TaskReport } from "./domain/TaskReport.js"
import type { TaskStatus } from "./domain/TaskStatus.js"
import { stopProcessGroup } from "./ProcessGroup.js"
import { Report } from "./Report.js"
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

const isTaskError = (error: TaskError | PlatformError | ReportError): error is TaskError =>
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
  const report = yield* Report
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
      for (const task of state.tasks) {
        if (task.tools !== "read-only") continue
        const adapter = agents.get(task.agent)
        if (
          Option.isNone(adapter) || adapter.value.capabilities.readOnlyTools !== true
          || options.loadProjectSettings || state.setup !== undefined
        ) {
          return yield* new AgentSpawnError({
            agent: task.agent,
            cause: "read-only tools require provider support and exclude project settings and setup",
            retryable: false,
          })
        }
      }
      yield* lock.acquire(state.repoRoot)
      yield* worktrees.recoverProcesses ?? Effect.void
      const current = yield* SynchronizedRef.make(state)

      const checkpoint = Effect.fn("Runner.checkpoint")(function*(taskId: TaskId, data: TaskReport) {
        yield* SynchronizedRef.updateEffect(current, (previous) => {
          const saved = previous.taskReports?.[taskId]
          if (saved?.attempt === data.attempt) {
            if (saved?.phase === "failed" && data.phase !== "failed") return Effect.succeed(previous)
            if ((saved?.phase === "completed" || saved?.phase === "delivered") && data.phase === "failed") {
              return Effect.succeed(previous)
            }
          }
          const next = new RunState({ ...previous, taskReports: { ...previous.taskReports, [taskId]: data } })
          return store.save(next).pipe(Effect.as(next))
        })
      }, Effect.uninterruptible)

      const deliver = Effect.fn("Runner.deliver")(function*(task: Task, emit = true, commit = true) {
        let previous = yield* SynchronizedRef.get(current)
        let data = previous.taskReports?.[task.id]
        const located = worktrees.locate(task.id)
        const savedPatch = yield* report.readPatch(previous, task.id)
        if (data?.phase === "delivered" && Option.isSome(savedPatch) && data.patchSha256 !== undefined) return
        let committed = false
        let deliveryCommit = data?.deliveryCommit
        let diff: Uint8Array
        if (data?.phase === "delivered") {
          if (Option.isSome(savedPatch)) {
            diff = savedPatch.value
          } else {
            if (deliveryCommit === undefined || data.patchSha256 === undefined) {
              return yield* new ReportError({
                path: previous.repoRoot,
                issue: `Missing patch for ${task.id} has no verified delivery identity`,
              })
            }
            diff = yield* worktrees.diff(located, state.baseSha, deliveryCommit)
          }
        } else {
          if (deliveryCommit === undefined) {
            if (!commit) {
              return yield* new ReportError({
                path: previous.repoRoot,
                issue: `Task ${task.id} has no delivery commit`,
              })
            }
            const prepared = yield* worktrees.snapshot(located, `agentrun(${task.id}): ${task.title}`)
            deliveryCommit = prepared.commit
            committed = prepared.committed
            yield* checkpoint(task.id, { ...data, phase: "completed", deliveryCommit })
            previous = yield* SynchronizedRef.get(current)
            data = previous.taskReports?.[task.id]
          }
          yield* worktrees.publish(located, deliveryCommit)
          diff = yield* worktrees.diff(located, state.baseSha, deliveryCommit)
        }
        const patchSha256 = createHash("sha256").update(diff).digest("hex")
        if (data?.patchSha256 !== undefined && data.patchSha256 !== patchSha256) {
          return yield* new ReportError({
            path: previous.repoRoot,
            issue: `Reconstructed patch digest differs for ${task.id}`,
          })
        }
        if (Option.isNone(savedPatch) || data?.phase !== "delivered") {
          yield* report.patch(previous, task.id, diff).pipe(Effect.uninterruptible)
        }
        const displayDiff = Buffer.from(diff).toString("utf8")
        let inHunk = false
        const diffStat = { files: 0, additions: 0, deletions: 0 }
        for (const line of displayDiff.split("\n")) {
          if (line.startsWith("diff --git ")) {
            diffStat.files++
            inHunk = false
          } else if (line.startsWith("@@ ")) inHunk = true
          else if (inHunk && line.startsWith("+")) diffStat.additions++
          else if (inHunk && line.startsWith("-")) diffStat.deletions++
        }
        yield* checkpoint(task.id, {
          ...data,
          phase: "delivered",
          diffStat: data?.diffStat ?? diffStat,
          deliveryCommit,
          patchSha256,
        })
        if (emit) {
          yield* PubSub.publish(pubsub, {
            _tag: "TaskDeliverable",
            taskId: task.id,
            branch: located.branch,
            committed,
            diff: displayDiff,
          })
        }
      })

      const transition = Effect.fn("Runner.transition")(function*(taskId: TaskId, status: TaskStatus) {
        yield* SynchronizedRef.updateEffect(current, (previous) =>
          Effect.gen(function*() {
            const from = previous.status[taskId]?._tag
            const to = status._tag
            const allowed = to === "running"
              ? from === "pending" || from === "interrupted" || from === "failed"
              : (from === "running" && (to === "succeeded" || to === "failed" || to === "interrupted"))
                || (from === "interrupted" && to === "failed")
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
            yield* report.save(next)
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
      for (const task of state.tasks) {
        const previous = yield* SynchronizedRef.get(current)
        const status = previous.status[task.id]
        const data = previous.taskReports?.[task.id]
        const currentAttempt = status !== undefined && "attempt" in status ? status.attempt : undefined
        const sameAttempt = currentAttempt === undefined || data?.attempt === undefined
          || data.attempt === currentAttempt
        const lastEvent = sameAttempt
          ? yield* report.lastEvent(previous, task.id, data?.eventOffset)
          : Option.none<AgentEvent>()
        if (data?.pendingEvent !== undefined) {
          if (Option.isNone(lastEvent) || JSON.stringify(lastEvent.value) !== JSON.stringify(data.pendingEvent)) {
            yield* report.append(previous, task.id, data.pendingEvent)
          }
          yield* checkpoint(task.id, { ...data, pendingEvent: undefined })
        } else if (
          status?._tag === "running" && data?.phase !== "completed" && data?.phase !== "delivered"
          && Option.isSome(lastEvent) && lastEvent.value._tag === "Completed"
        ) {
          return yield* new ReportError({
            path: previous.repoRoot,
            issue: `Completed event for ${task.id} lacks its checkpoint; refusing provider replay`,
          })
        }
        if (
          (status?._tag === "running" || status?._tag === "interrupted") && status.attempt > 1
          && data?.eventOffset === undefined && data?.phase !== "failed"
          && Option.isSome(lastEvent) && lastEvent.value._tag === "Failed"
        ) {
          return yield* new ReportError({
            path: previous.repoRoot,
            issue: `Failed event for ${task.id} has no attempt boundary; refusing ambiguous recovery`,
          })
        }
        if (
          (status?._tag === "running" || status?._tag === "interrupted") && sameAttempt
          && (data?.phase === "failed" || (Option.isSome(lastEvent) && lastEvent.value._tag === "Failed"))
        ) {
          const reason = data?.failureReason ?? (Option.isSome(lastEvent) && lastEvent.value._tag === "Failed"
            ? `AgentTaskFailed: ${lastEvent.value.reason}`
            : "AgentTaskFailed: unavailable")
          yield* transition(task.id, { _tag: "failed", attempt: status.attempt, reason })
          continue
        }
        if (status?._tag === "succeeded") {
          if (data === undefined) {
            yield* checkpoint(task.id, {
              phase: "delivered",
              durationMs: status.durationMs,
              ...(status.costUsd === undefined ? {} : { costUsd: status.costUsd }),
            })
          }
          if (data !== undefined && data.phase !== "delivered" && data.deliveryCommit === undefined) {
            yield* checkpoint(task.id, { ...data, phase: "delivered" })
          }
          yield* deliver(task, false, false)
        } else if (data?.phase === "completed" || data?.phase === "delivered") {
          if (status?._tag !== "running") {
            yield* transition(task.id, {
              _tag: "running",
              attempt: status && "attempt" in status ? status.attempt : 1,
              startedAt: yield* DateTime.now,
            })
          }
          yield* deliver(task, data.phase !== "delivered")
          if (data.durationMs === undefined) {
            return yield* new ReportError({
              path: previous.repoRoot,
              issue: `Completed task ${task.id} lacks timing; refusing fabricated duration`,
            })
          }
          yield* transition(task.id, {
            _tag: "succeeded",
            durationMs: data.durationMs,
            ...(data.costUsd === undefined ? {} : { costUsd: data.costUsd }),
          })
        }
      }
      const reconciled = yield* worktrees.reconcile(yield* SynchronizedRef.get(current))
      for (const action of reconciled) {
        const status = (yield* SynchronizedRef.get(current)).status[action.taskId]
        if (action._tag === "Interrupted" && status?._tag === "running") {
          yield* transition(action.taskId, { _tag: "interrupted", attempt: status.attempt })
        } else if (action._tag === "WorktreeMissing" && status?._tag === "running") {
          yield* transition(
            action.taskId,
            { _tag: "failed", attempt: status.attempt, reason: "worktree missing" },
          )
        } else if (action._tag === "Recreated") {
          const data = (yield* SynchronizedRef.get(current)).taskReports?.[action.taskId]
          if (data !== undefined) yield* checkpoint(action.taskId, { ...data, setupCompleted: false })
        } else if (action._tag === "RemoveFailed") {
          yield* PubSub.publish(pubsub, { _tag: "TaskWarning", taskId: action.taskId, message: action.stderr })
        }
      }

      const recordFailure = Effect.fn("Runner.recordFailure")(function*(taskId: TaskId, error: TaskError) {
        const previous = yield* SynchronizedRef.get(current)
        const status = previous.status[taskId]
        if (status?._tag !== "running") return
        const data = previous.taskReports?.[taskId]
        if (data?.phase === "completed" || data?.phase === "delivered" || data?.phase === "failed") return
        yield* checkpoint(taskId, {
          ...data,
          phase: "failed",
          failureReason: `${error._tag}: ${detail(error)}`,
          durationMs: (data?.elapsedBeforeMs ?? 0)
            + Math.floor((yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(status.startedAt)),
        })
      })

      const runTask = Effect.fn("Runner.runTask")(
        function*(task: Task): Effect.fn.Return<void, TaskError | PlatformError | ReportError> {
          const startedAt = yield* DateTime.now
          const start = yield* Clock.currentTimeMillis
          const previous = (yield* SynchronizedRef.get(current)).status[task.id]
          const attempt = previous?._tag === "interrupted" || previous?._tag === "failed" ? previous.attempt + 1 : 1
          const priorData = (yield* SynchronizedRef.get(current)).taskReports?.[task.id]
          let toolsStarted = priorData?.toolsStarted === true
          let setupDone = priorData?.setupCompleted === true
          let adapterAttempt = 0
          const elapsedBeforeMs = priorData?.durationMs ?? 0
          let priorCost = priorData?.costUsd
          let attemptCost: number | undefined
          const retryable = (error: TaskError | PlatformError | ReportError) =>
            adapterAttempt < 3 && !toolsStarted && (state.setup === undefined || setupDone)
            && (error._tag === "AgentCrashed" || (error._tag === "AgentSpawnError" && retryableSpawnError(error)))
          const terminal = (error: TaskError) => recordFailure(task.id, error).pipe(Effect.andThen(Effect.fail(error)))
          const spawnError = (cause: unknown) => new AgentSpawnError({ agent: task.agent, cause, retryable: false })
          yield* Effect.scoped(
            Effect.gen(function*() {
              const worktree = yield* Effect.gen(function*() {
                yield* checkpoint(task.id, {
                  phase: "unfinished",
                  attempt,
                  eventOffset: yield* report.eventSize(state, task.id),
                  toolsStarted,
                  setupCompleted: setupDone,
                  elapsedBeforeMs,
                  durationMs: elapsedBeforeMs,
                  ...(priorCost === undefined ? {} : { costUsd: priorCost }),
                })
                yield* transition(task.id, { _tag: "running", attempt, startedAt })
                return yield* worktrees.acquire(task, state.baseSha, () => toolsStarted, () =>
                  Effect.gen(function*() {
                    setupDone = false
                    yield* checkpoint(task.id, {
                      ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                      phase: "unfinished",
                      setupCompleted: false,
                    })
                  }).pipe(Effect.mapError((error) =>
                    new GitError({
                      command: "worktree setup checkpoint",
                      exitCode: -1,
                      stderr: error.message,
                    })
                  )))
              })
              if (state.setup !== undefined && !options.setupInAgent && !setupDone) {
                yield* setup(task.id, state.setup, worktree.path)
                setupDone = true
                yield* checkpoint(task.id, {
                  ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                  phase: "unfinished",
                  setupCompleted: true,
                })
              }
              const adapter = agents.get(task.agent)
              if (Option.isNone(adapter)) {
                return yield* Effect.die(`Missing agent adapter: ${task.agent} for task ${task.id}`)
              }
              const execute = Effect.suspend(() =>
                Effect.gen(function*() {
                  adapterAttempt++
                  attemptCost = undefined
                  yield* checkpoint(task.id, {
                    ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                    phase: "unfinished",
                    adapterAttempt,
                  })
                  let lastEventAt = yield* Clock.currentTimeMillis
                  const consume = adapter.value.run({
                    taskId: task.id,
                    ...(task.tools === undefined ? {} : { tools: task.tools }),
                    loadProjectSettings: options.loadProjectSettings === true,
                    ...(options.setupInAgent && state.setup !== undefined && !setupDone ? { setup: state.setup } : {}),
                    setupCompleted: () =>
                      Effect.gen(function*() {
                        setupDone = true
                        yield* checkpoint(task.id, {
                          ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                          phase: "unfinished",
                          setupCompleted: true,
                        })
                      }).pipe(Effect.mapError(spawnError)),
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
                      }).pipe(Effect.mapError((cause) => spawnError(cause))),
                    prompt: task.prompt,
                    cwd: worktree.path,
                    model: Option.fromUndefinedOr(task.model),
                    maxTurns: Option.fromUndefinedOr(task.maxTurns),
                    maxBudgetUsd: Option.fromUndefinedOr(task.maxBudgetUsd),
                  }).pipe(
                    Stream.tapError((error) =>
                      isTaskError(error) && !retryable(error) ? recordFailure(task.id, error) : Effect.void
                    ),
                    Stream.rechunk(1),
                    Stream.runFoldEffect(
                      (): { readonly last: Option.Option<AgentEvent>; readonly costUsd: number | undefined } => ({
                        last: Option.none(),
                        costUsd: undefined,
                      }),
                      (summary, event) =>
                        Effect.gen(function*() {
                          lastEventAt = yield* Clock.currentTimeMillis
                          if (event._tag === "ToolCall") {
                            toolsStarted = true
                            yield* checkpoint(task.id, {
                              ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                              phase: "unfinished",
                              toolsStarted: true,
                              durationMs: elapsedBeforeMs + Math.floor((yield* Clock.currentTimeMillis) - start),
                            })
                          }
                          if (event._tag === "Usage" && event.costUsd !== undefined) {
                            attemptCost = (summary.costUsd ?? 0) + event.costUsd
                            const data = (yield* SynchronizedRef.get(current)).taskReports?.[task.id]
                            yield* checkpoint(task.id, {
                              ...data,
                              phase: "unfinished",
                              costUsd: (priorCost ?? 0) + attemptCost,
                              durationMs: elapsedBeforeMs + Math.floor((yield* Clock.currentTimeMillis) - start),
                            })
                          }
                          if (event._tag === "Completed") {
                            attemptCost = event.costUsd ?? summary.costUsd
                            const costUsd = attemptCost === undefined && priorCost === undefined
                              ? undefined
                              : (priorCost ?? 0) + (attemptCost ?? 0)
                            yield* checkpoint(task.id, {
                              ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                              phase: "completed",
                              pendingEvent: event,
                              result: event.result,
                              durationMs: elapsedBeforeMs + Math.floor((yield* Clock.currentTimeMillis) - start),
                              ...(costUsd === undefined ? {} : { costUsd }),
                            })
                          }
                          if (event._tag === "Failed") {
                            yield* checkpoint(task.id, {
                              ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                              phase: "failed",
                              pendingEvent: event,
                              failureReason: `AgentTaskFailed: ${event.reason}`,
                              durationMs: elapsedBeforeMs + Math.floor((yield* Clock.currentTimeMillis) - start),
                            })
                          }
                          yield* report.append(state, task.id, event)
                          if (event._tag === "Completed" || event._tag === "Failed") {
                            const data = (yield* SynchronizedRef.get(current)).taskReports?.[task.id]
                            yield* checkpoint(task.id, {
                              ...data,
                              phase: event._tag === "Completed" ? "completed" : "failed",
                              pendingEvent: undefined,
                            })
                          }
                          yield* PubSub.publish(pubsub, { _tag: "TaskAgentEvent", taskId: task.id, event })
                          if (event._tag === "Failed") {
                            return yield* new AgentTaskFailed({ agent: task.agent, reason: event.reason })
                          }
                          return {
                            last: Option.some(event),
                            costUsd: event._tag === "Usage" && event.costUsd !== undefined
                              ? (summary.costUsd ?? 0) + event.costUsd
                              : summary.costUsd,
                          }
                        }),
                    ),
                  )
                  const stalled = Effect.gen(function*() {
                    while (true) {
                      const remaining = Duration.toMillis(task.stallTimeout)
                        - ((yield* Clock.currentTimeMillis) - lastEventAt)
                      if (remaining <= 0) {
                        return yield* terminal(new AgentStalled({ agent: task.agent, idleFor: task.stallTimeout }))
                      }
                      yield* Effect.sleep(remaining)
                    }
                  })
                  return yield* Effect.raceFirst(consume, stalled)
                }).pipe(Effect.tapError((error) =>
                  isTaskError(error) && !retryable(error) ? recordFailure(task.id, error) : Effect.void
                ))
              ).pipe(Effect.scoped)
              const summary = yield* execute.pipe(Effect.retry({
                schedule: Schedule.exponential("1 second").pipe(Schedule.jittered, Schedule.upTo({ times: 2 })),
                while: (error) =>
                  Effect.gen(function*() {
                    if (!isTaskError(error) || !retryable(error)) return false
                    if (attemptCost !== undefined) priorCost = (priorCost ?? 0) + attemptCost
                    yield* checkpoint(task.id, {
                      ...(yield* SynchronizedRef.get(current)).taskReports?.[task.id],
                      phase: "unfinished",
                      durationMs: elapsedBeforeMs + Math.floor((yield* Clock.currentTimeMillis) - start),
                    })
                    const event: AgentEvent = {
                      _tag: "Retry",
                      source: "runner",
                      attempt: adapterAttempt + 1,
                      reason: `${error._tag}: ${detail(error)}`,
                    }
                    yield* report.append(state, task.id, event)
                    yield* PubSub.publish(pubsub, { _tag: "TaskAgentEvent", taskId: task.id, event })
                    return true
                  }),
              }))
              if (Option.isNone(summary.last) || summary.last.value._tag !== "Completed") {
                return yield* Effect.die(`Adapter ${task.agent} ended the stream without Completed or Failed`)
              }
              yield* deliver(task)
            }).pipe(
              Effect.raceFirst(
                Effect.sleep(task.maxDuration).pipe(
                  Effect.andThen(terminal(new AgentTimedOut({ agent: task.agent, after: task.maxDuration }))),
                ),
              ),
              Effect.tapError((error) => isTaskError(error) ? recordFailure(task.id, error) : Effect.void),
            ),
          ).pipe(Effect.onExit((exit) =>
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
          const data = (yield* SynchronizedRef.get(current)).taskReports?.[task.id]
          const costUsd = data?.costUsd
          const durationMs = data?.durationMs ?? Math.floor((yield* Clock.currentTimeMillis) - start)
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
                    yield* recordFailure(task.id, error)
                    const data = (yield* SynchronizedRef.get(current)).taskReports?.[task.id]
                    yield* transition(task.id, {
                      _tag: "failed",
                      attempt: status.attempt,
                      reason: data?.failureReason ?? `${error._tag}: ${detail(error)}`,
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
                  const data = (yield* SynchronizedRef.get(current)).taskReports?.[task.id]
                  yield* checkpoint(task.id, {
                    ...data,
                    phase: data?.phase ?? "unfinished",
                    durationMs: (data?.elapsedBeforeMs ?? 0)
                      + Math.floor((yield* Clock.currentTimeMillis) - DateTime.toEpochMillis(status.startedAt)),
                  })
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
      const final = yield* SynchronizedRef.get(current)
      yield* report.save(final)
      return final
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
