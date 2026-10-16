import { NodeStream } from "@effect/platform-node"
import { Context, Effect, Exit, FileSystem, Layer, Path, Schema, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { GitError } from "./domain/Errors.js"
import type { RunState } from "./domain/RunState.js"
import { TaskId } from "./domain/Task.js"
import type { Task } from "./domain/Task.js"
import * as OwnershipRecords from "./OwnershipRecords.js"
import { stopProcessGroup } from "./ProcessGroup.js"
import { repoIdentity } from "./RepoHash.js"

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
  readonly recoverProcesses?: Effect.Effect<void, GitError>
  readonly locate: (taskId: TaskId) => Worktree
  readonly assertAvailable: (taskId: TaskId) => Effect.Effect<void, GitError>
  readonly acquire: (
    task: Task,
    baseSha: string,
    retainOnFailure?: () => boolean,
    onCreate?: () => Effect.Effect<void, GitError>,
  ) => Effect.Effect<Worktree, GitError, Scope.Scope>
  readonly commit: (worktree: Worktree, message: string) => Effect.Effect<boolean, GitError>
  readonly snapshot: (
    worktree: Worktree,
    message: string,
  ) => Effect.Effect<{ readonly commit: string; readonly committed: boolean }, GitError>
  readonly publish: (worktree: Worktree, commit: string) => Effect.Effect<void, GitError>
  readonly diff: (worktree: Worktree, baseSha: string, commit?: string) => Effect.Effect<Uint8Array, GitError>
  readonly reconcile: (state: RunState) => Effect.Effect<ReadonlyArray<Reconciled>, GitError>
}>()("agentrun/Worktrees") {
  static readonly layer = (options: Options) => Layer.effect(Worktrees, make(options))
}

const make = Effect.fn("Worktrees.make")(function*(options: Options) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const semaphore = yield* Semaphore.make(options.permits ?? 1)

  const { commonDir, hash } = yield* repoIdentity(options.repoRoot)
  const processes = path.join(options.home, ".agentrun", "git", hash, options.runId)
  const processError = (cause: unknown) =>
    new GitError({ command: "owned Git cleanup", exitCode: -1, stderr: String(cause) })
  const recoverProcesses = Effect.gen(function*() {
    if (!(yield* fs.exists(processes).pipe(Effect.orDie))) return
    for (const entry of yield* fs.readDirectory(processes).pipe(Effect.orDie)) {
      const file = path.join(processes, entry)
      const lease = yield* Effect.try({
        try: () => JSON.parse(entry.slice(0, -5)) as unknown,
        catch: processError,
      })
      if (typeof lease !== "number" || !Number.isSafeInteger(lease) || !entry.endsWith(".json")) {
        return yield* processError("Invalid Git process journal")
      }
      const token = yield* fs.readFileString(file).pipe(Effect.mapError(processError))
      yield* stopProcessGroup(lease, token, "git").pipe(Effect.mapError(processError))
      yield* fs.remove(file).pipe(Effect.mapError(processError))
    }
  })

  const gitBytes = Effect.fn("Worktrees.gitBytes")(
    function*(args: ReadonlyArray<string>, { cwd }: { readonly cwd: string }) {
      const command = `git ${args.join(" ")}`
      const error = (cause: unknown) => new GitError({ command, exitCode: -1, stderr: String(cause) })
      const token = randomBytes(16).toString("hex")
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(process.execPath, [
              "-e",
              `
const {spawn}=require('node:child_process');
let done=false;
process.on('SIGTERM',()=>{if(done) process.exit(0)});
for(const stream of [process.stdout,process.stderr]) stream.on('error',e=>{if(e.code!=='EPIPE') throw e});
process.stdin.resume();
process.stdin.on('end',()=>process.kill(-process.pid,'SIGKILL'));
process.stdin.once('data',()=>{
 const child=spawn('git',process.argv.slice(1,-1),{stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(process.stdout,{end:false});
 child.stderr.pipe(process.stderr,{end:false});
 child.on('error',e=>console.error(e.message));
 child.on('close',code=>{done=true;process.send(code ?? -1);process.stdout.end();process.stderr.end()});
});
`,
              "--",
              ...args,
              `agentrun-git-${token}`,
            ], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"] }),
          catch: error,
        }),
        (child) =>
          Effect.gen(function*() {
            if (child.pid === undefined) return
            yield* stopProcessGroup(child.pid, token, "git").pipe(Effect.orDie)
            const journal = path.join(processes, `${child.pid}.json`)
            if (yield* fs.exists(journal).pipe(Effect.orDie)) yield* fs.remove(journal).pipe(Effect.orDie)
          }),
      )
      child.on("error", () => {})
      const { stdin, stdout: output, stderr: errors } = child
      if (stdin === null || output === null || errors === null) return yield* error("Git pipes did not start")
      stdin.on("error", () => {})
      if (child.pid === undefined) return yield* error("Git leader did not start")
      yield* Effect.gen(function*() {
        yield* fs.makeDirectory(processes, { recursive: true, mode: 0o700 })
        yield* fs.writeFileString(path.join(processes, `${child.pid}.json`), token, { mode: 0o600 })
        stdin.write("start\n")
      }).pipe(Effect.uninterruptible, Effect.mapError(error))
      const exit = Effect.callback<number, GitError>((resume) => {
        const done = (code: unknown) =>
          resume(typeof code === "number" ? Effect.succeed(code) : Effect.fail(error("Invalid Git exit status")))
        const failed = (cause: Error) => resume(Effect.fail(error(cause)))
        child.once("message", done)
        child.once("error", failed)
        if (child.exitCode !== null) done(child.exitCode)
        return Effect.sync(() => {
          child.off("message", done)
          child.off("error", failed)
        })
      })
      const [stdout, stderr, exitCode] = yield* Effect.all([
        NodeStream.fromReadable({ evaluate: () => output, onError: error }).pipe(
          Stream.runCollect,
          Effect.map((chunks) => Buffer.concat(chunks)),
        ),
        NodeStream.fromReadable({ evaluate: () => errors, onError: error }).pipe(Stream.decodeText(), Stream.mkString),
        exit,
      ], { concurrency: "unbounded" }).pipe(
        Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.fail(error("Git exceeded 60000ms")) }),
      )
      if (exitCode !== 0) return yield* new GitError({ command, exitCode, stderr })
      return stdout
    },
    Effect.scoped,
  )

  const git = (args: ReadonlyArray<string>, cwd: { readonly cwd: string }) =>
    gitBytes(args, cwd).pipe(Effect.map((bytes) => bytes.toString("utf8").trim()))

  const repo = { cwd: options.repoRoot }
  const ownership = path.join(commonDir, "agentrun", "ownership", "branches")
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

  const receipt = (worktree: Worktree) =>
    path.join(ownership, `${createHash("sha256").update(worktree.branch.toLowerCase()).digest("hex")}.json`)
  const owner = (worktree: Worktree) =>
    JSON.stringify({
      version: 1,
      runId: options.runId,
      repoRoot: options.repoRoot,
      taskId: worktree.taskId,
      path: worktree.path,
      branch: worktree.branch,
    })
  const refusal = (worktree: Worktree, reason: string) =>
    new GitError({
      command: "worktree ownership",
      exitCode: -1,
      stderr:
        `Worktree ownership is unproved for ${worktree.branch}: ${reason}. Preserve the files and inspect the run and repository.`,
    })
  const matchingBranches = (worktree: Worktree) =>
    git(["for-each-ref", "--format=%(refname)", "refs/heads"], repo).pipe(
      Effect.map((refs) =>
        refs.split("\n").filter((ref) => ref.toLowerCase() === `refs/heads/${worktree.branch}`.toLowerCase())
      ),
    )
  const assertAvailable = Effect.fn("Worktrees.assertAvailable")(function*(taskId: TaskId) {
    const worktree = locate(taskId)
    yield* OwnershipRecords.validateGenerated(owner(worktree)).pipe(
      Effect.mapError(() => refusal(worktree, "creation receipt could not be saved")),
    )
    if (
      (yield* fs.exists(worktree.path).pipe(Effect.mapError(processError)))
      || (yield* OwnershipRecords.exists(receipt(worktree)).pipe(Effect.mapError(processError)))
      || (yield* matchingBranches(worktree)).length > 0
    ) {
      return yield* new GitError({
        command: "worktree ownership",
        exitCode: -1,
        stderr: `Worktree collision: ${worktree.branch}; choose a different run ID`,
      })
    }
  })
  const inspect = Effect.fn("Worktrees.inspect")(function*(worktree: Worktree) {
    const expected = locate(worktree.taskId)
    if (worktree.path !== expected.path || worktree.branch !== expected.branch) {
      return yield* refusal(worktree, "resource identity differs")
    }
    const dir = yield* fs.exists(worktree.path).pipe(Effect.mapError(processError))
    const branches = yield* matchingBranches(worktree)
    if (branches.some((branch) => branch !== `refs/heads/${worktree.branch}`)) {
      return yield* refusal(worktree, "case-only branch collision")
    }
    const file = receipt(worktree)
    const owned = yield* OwnershipRecords.exists(file).pipe(
      Effect.mapError(() => refusal(worktree, "creation receipt cannot be read")),
    )
    if (owned) {
      yield* OwnershipRecords.read(file, OwnershipRecords.BranchReceipt, owner(worktree)).pipe(
        Effect.mapError(() => refusal(worktree, "creation receipt belongs to another run or is invalid")),
      )
    } else if (dir || branches.length > 0) {
      return yield* refusal(worktree, "creation receipt is missing")
    }
    if (dir) {
      const identity = yield* git([
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--symbolic-full-name",
        "HEAD",
      ], { cwd: worktree.path }).pipe(Effect.mapError(() => refusal(worktree, "workspace Git identity cannot be read")))
      const [directory, branch] = identity.split("\n")
      if (
        directory === undefined || branch !== `refs/heads/${worktree.branch}` || branches.length !== 1
        || (yield* fs.realPath(directory).pipe(
            Effect.mapError(() => refusal(worktree, "repository cannot be resolved")),
          ))
          !== commonDir
      ) return yield* refusal(worktree, "workspace Git identity differs")
    }
    return { dir, branch: branches.length === 1, owned }
  })
  const assertOwned = Effect.fn("Worktrees.assertOwned")(function*(worktree: Worktree) {
    if (!(yield* inspect(worktree)).owned) return yield* refusal(worktree, "creation receipt is missing")
  })

  const remove = Effect.fn("Worktrees.remove")(function*(worktree: Worktree) {
    yield* assertOwned(worktree)
    yield* git(["worktree", "remove", worktree.path], repo).pipe(semaphore.withPermits(1))
  })

  const acquire = Effect.fn("Worktrees.acquire")(
    function*(
      task: Task,
      baseSha: string,
      retainOnFailure?: () => boolean,
      onCreate?: () => Effect.Effect<void, GitError>,
    ) {
      return yield* Effect.acquireRelease(
        Effect.gen(function*() {
          const worktree = locate(task.id)
          yield* OwnershipRecords.validateGenerated(owner(worktree)).pipe(
            Effect.mapError(() => refusal(worktree, "creation receipt could not be saved")),
          )
          const existing = yield* inspect(worktree)
          yield* fs.makeDirectory(path.dirname(worktree.path), { recursive: true }).pipe(Effect.orDie)
          if (existing.dir) return worktree
          yield* onCreate?.() ?? Effect.void
          yield* git(
            existing.branch
              ? ["worktree", "add", worktree.path, worktree.branch]
              : ["worktree", "add", "-b", worktree.branch, worktree.path, baseSha],
            repo,
          ).pipe(semaphore.withPermits(1))
          if (!existing.owned) {
            yield* fs.makeDirectory(ownership, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(processError))
            yield* fs.writeFileString(receipt(worktree), owner(worktree), { flag: "wx", mode: 0o600 }).pipe(
              Effect.mapError(() => refusal(worktree, "creation receipt could not be saved")),
            )
          }
          return worktree
        }),
        (worktree, exit) =>
          options.keepWorktrees === true || Exit.hasInterrupts(exit)
            || (Exit.isFailure(exit) && retainOnFailure?.() === true)
            ? Effect.void
            : remove(worktree).pipe(
              Effect.catchTag("GitError", (error) => Effect.logWarning("Worktree removal failed", error)),
            ),
        { interruptible: true },
      )
    },
  )

  const snapshot = Effect.fn("Worktrees.snapshot")(function*(worktree: Worktree, message: string) {
    yield* assertOwned(worktree)
    const cwd = { cwd: worktree.path }
    yield* git(["add", "-A"], cwd)
    const parent = yield* git(["rev-parse", "HEAD"], cwd)
    if ((yield* git(["status", "--porcelain"], cwd)) === "") return { commit: parent, committed: false }
    const tree = yield* git(["write-tree"], cwd)
    const commit = yield* git([
      "-c",
      "user.name=agentrun",
      "-c",
      "user.email=agentrun@localhost",
      "commit-tree",
      tree,
      "-p",
      parent,
      "-m",
      message,
    ], cwd)
    return { commit, committed: true }
  })
  const publish = Effect.fn("Worktrees.publish")(function*(worktree: Worktree, commit: string) {
    yield* assertOwned(worktree)
    const ref = `refs/heads/${worktree.branch}`
    const current = yield* git(["rev-parse", "--verify", ref], repo)
    const delivered = yield* git(["merge-base", "--is-ancestor", commit, current], repo).pipe(
      Effect.as(true),
      Effect.catchTag("GitError", (error) => error.exitCode === 1 ? Effect.succeed(false) : Effect.fail(error)),
    )
    if (delivered) return
    const parent = yield* git(["rev-parse", `${commit}^`], repo)
    // Compare-and-swap refuses to overwrite a user branch changed before publication.
    yield* git(["update-ref", ref, commit, parent], repo)
  })
  const commit = Effect.fn("Worktrees.commit")(function*(worktree: Worktree, message: string) {
    const prepared = yield* snapshot(worktree, message)
    yield* publish(worktree, prepared.commit)
    return prepared.committed
  })

  const diff = Effect.fn("Worktrees.diff")(function*(worktree: Worktree, baseSha: string, commit?: string) {
    if (commit === undefined) yield* assertOwned(worktree)
    return yield* gitBytes(["diff", "--binary", `${baseSha}..${commit ?? worktree.branch}`], repo)
  })

  const reconcile = Effect.fn("Worktrees.reconcile")(function*(state: RunState) {
    for (const task of state.tasks) {
      const recorded = state.worktrees[task.id]
      yield* inspect(recorded === undefined ? locate(task.id) : { taskId: task.id, ...recorded })
    }
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
        !options.keepWorktrees && !(status?._tag === "failed" && state.taskReports?.[taskId]?.toolsStarted)
        && (status?._tag === "succeeded" || status?._tag === "failed") && dir && branch
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

  return Worktrees.of({
    recoverProcesses,
    locate,
    assertAvailable,
    acquire,
    commit,
    diff,
    reconcile,
    snapshot,
    publish,
  })
})
