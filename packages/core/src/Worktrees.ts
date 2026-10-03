import { Context, Effect, Exit, FileSystem, Layer, Path, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { GitError } from "./domain/Errors.js"
import type { RunState } from "./domain/RunState.js"
import { TaskId } from "./domain/Task.js"
import type { Task } from "./domain/Task.js"
import { repoHash } from "./RepoHash.js"

export interface Worktree {
  readonly taskId: TaskId
  readonly path: string
  readonly branch: string
}

export const Reconciled = Schema.Union([
  Schema.TaggedStruct("Nothing", { taskId: TaskId }),
  Schema.TaggedStruct("RemovedIntent", { taskId: TaskId }),
  Schema.TaggedStruct("Interrupted", { taskId: TaskId }),
  Schema.TaggedStruct("WorktreeMissing", { taskId: TaskId }),
  Schema.TaggedStruct("Resumable", { taskId: TaskId }),
  Schema.TaggedStruct("Recreated", { taskId: TaskId }),
  Schema.TaggedStruct("Removed", { taskId: TaskId }),
  Schema.TaggedStruct("RemoveFailed", { taskId: TaskId, stderr: Schema.String }),
])
export type Reconciled = typeof Reconciled.Type

interface Options {
  readonly repoRoot: string
  readonly runId: string
  readonly home: string
  readonly keepWorktrees?: boolean
  readonly permits?: number
}

export class Worktrees extends Context.Service<Worktrees, {
  readonly locate: (taskId: TaskId) => Worktree
  readonly acquire: (task: Task, baseSha: string) => Effect.Effect<Worktree, GitError, Scope.Scope>
  readonly commit: (worktree: Worktree, message: string) => Effect.Effect<boolean, GitError>
  readonly diff: (worktree: Worktree, baseSha: string) => Effect.Effect<string, GitError>
  readonly reconcile: (state: RunState) => Effect.Effect<ReadonlyArray<Reconciled>, GitError>
}>()("agentrun/Worktrees") {
  static readonly layer = (options: Options) => Layer.effect(Worktrees, make(options))
}

const make = Effect.fn("Worktrees.make")(function*(options: Options) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const semaphore = yield* Semaphore.make(options.permits ?? 1)

  const git = Effect.fn("Worktrees.git")(function*(args: ReadonlyArray<string>, { cwd }: { readonly cwd: string }) {
    const command = `git ${args.join(" ")}`
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd })).pipe(
      Effect.mapError((error) => new GitError({ command, exitCode: -1, stderr: error.message })),
    )
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ], { concurrency: "unbounded" }).pipe(
      Effect.mapError((error) => new GitError({ command, exitCode: -1, stderr: error.message })),
    )
    if (exitCode !== 0) return yield* new GitError({ command, exitCode, stderr })
    return stdout.trim()
  }, Effect.scoped)

  const repo = { cwd: options.repoRoot }
  const hash = yield* repoHash(options.repoRoot)
  const locate = (taskId: TaskId): Worktree => ({
    taskId,
    path: path.join(options.home, ".agentrun", "worktrees", hash, options.runId, taskId),
    branch: `agentrun/${taskId}-${options.runId.slice(-4)}`,
  })

  const branchExists = Effect.fn("Worktrees.branchExists")(function*(branch: string) {
    return yield* git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo).pipe(
      Effect.as(true),
      Effect.catchTag("GitError", (error) => error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error)),
    )
  })

  const remove = Effect.fn("Worktrees.remove")(function*(worktree: Worktree) {
    yield* git(["worktree", "remove", worktree.path], repo).pipe(semaphore.withPermits(1))
  })

  const acquire = Effect.fn("Worktrees.acquire")(function*(task: Task, baseSha: string) {
    return yield* Effect.acquireRelease(
      Effect.gen(function*() {
        const worktree = locate(task.id)
        yield* fs.makeDirectory(path.dirname(worktree.path), { recursive: true }).pipe(Effect.orDie)
        if (yield* fs.exists(worktree.path).pipe(Effect.orDie)) {
          const branch = yield* git(["symbolic-ref", "--short", "HEAD"], { cwd: worktree.path })
          if (branch !== worktree.branch) {
            return yield* new GitError({
              command: "reuse worktree",
              exitCode: -1,
              stderr: "Recorded worktree has a different branch",
            })
          }
          return worktree
        }
        const exists = yield* branchExists(worktree.branch)
        yield* git(
          exists
            ? ["worktree", "add", worktree.path, worktree.branch]
            : ["worktree", "add", "-b", worktree.branch, worktree.path, baseSha],
          repo,
        ).pipe(semaphore.withPermits(1))
        return worktree
      }),
      (worktree, exit) =>
        options.keepWorktrees === true || Exit.hasInterrupts(exit) ? Effect.void : remove(worktree).pipe(
          Effect.catchTag("GitError", (error) => Effect.logWarning("Worktree removal failed", error)),
        ),
    )
  })

  const commit = Effect.fn("Worktrees.commit")(function*(worktree: Worktree, message: string) {
    const cwd = { cwd: worktree.path }
    yield* git(["add", "-A"], cwd)
    const status = yield* git(["status", "--porcelain"], cwd)
    if (status === "") return false
    yield* git(["-c", "user.name=agentrun", "-c", "user.email=agentrun@localhost", "commit", "-m", message], cwd)
    return true
  })

  const diff = Effect.fn("Worktrees.diff")(function*(worktree: Worktree, baseSha: string) {
    return yield* git(["diff", `${baseSha}..${worktree.branch}`], { cwd: worktree.path })
  })

  const reconcile = Effect.fn("Worktrees.reconcile")(function*(state: RunState) {
    yield* git(["worktree", "prune"], repo).pipe(semaphore.withPermits(1))
    const actions: Array<Reconciled> = []
    for (const task of state.tasks) {
      const taskId = task.id
      const status = state.status[taskId]
      const recorded = state.worktrees[taskId]
      const worktree = recorded === undefined ? locate(taskId) : { taskId, ...recorded }
      const dir = yield* fs.exists(worktree.path).pipe(Effect.orDie)
      const branch = yield* branchExists(worktree.branch)
      if (status?._tag === "pending" && branch) {
        const removed = dir ? yield* remove(worktree).pipe(Effect.result) : undefined
        if (removed?._tag === "Failure") {
          yield* Effect.logWarning("Worktree removal failed", removed.failure)
          actions.push({ _tag: "RemoveFailed", taskId, stderr: removed.failure.stderr })
        } else {
          yield* git(["branch", "-D", worktree.branch], repo).pipe(semaphore.withPermits(1))
          actions.push({ _tag: "RemovedIntent", taskId })
        }
      } else if (status?._tag === "running") {
        actions.push({ _tag: dir && branch ? "Interrupted" : "WorktreeMissing", taskId })
      } else if (status?._tag === "interrupted" && branch) {
        if (dir) {
          actions.push({ _tag: "Resumable", taskId })
        } else {
          yield* fs.makeDirectory(path.dirname(worktree.path), { recursive: true }).pipe(Effect.orDie)
          yield* git(["worktree", "add", worktree.path, worktree.branch], repo).pipe(semaphore.withPermits(1))
          actions.push({ _tag: "Recreated", taskId })
        }
      } else if (
        !options.keepWorktrees && (status?._tag === "succeeded" || status?._tag === "failed") && dir && branch
      ) {
        const removed = yield* remove(worktree).pipe(Effect.result)
        if (removed._tag === "Failure") {
          yield* Effect.logWarning("Worktree removal failed", removed.failure)
          actions.push({ _tag: "RemoveFailed", taskId, stderr: removed.failure.stderr })
        } else {
          actions.push({ _tag: "Removed", taskId })
        }
      } else {
        actions.push({ _tag: "Nothing", taskId })
      }
    }
    return actions
  })

  return Worktrees.of({ locate, acquire, commit, diff, reconcile })
})
