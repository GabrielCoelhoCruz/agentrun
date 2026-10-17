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

const GitStatus = Schema.Struct({ code: Schema.Int, cleanup: Schema.Boolean })

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
      const bytes = yield* OwnershipRecords.readBytes(file).pipe(
        Effect.mapError(() => processError("Expected a stable regular file within the bounded record limit")),
      )
      const token = bytes.toString("utf8")
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
const {spawn,execFile}=require('node:child_process');
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
 child.on('close',code=>{
  done=true;
  process.stdout.end(()=>process.stderr.end(()=>{
   // A detached wrapper leads its session. Linux selects sessions; macOS selects groups.
   const probe=execFile('ps',['-o','pid=,pgid=,stat=',process.platform==='darwin'?'-g':'-s',String(process.pid)],{timeout:5000,env:{...process.env,LC_ALL:'C'}},(error,stdout)=>{
    const rows=stdout.trim().split(/\\r?\\n/).map(line=>/^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s*$/.exec(line));
    const valid=!error && rows.every(row=>row!==null)
     && rows.some(row=>Number(row[1])===process.pid && Number(row[2])===process.pid)
     && new Set(rows.map(row=>row[1])).size===rows.length;
    const cleanup=!valid || rows.some(row=>Number(row[2])===process.pid
     && Number(row[1])!==process.pid && Number(row[1])!==probe.pid
     && !row[3].includes('Z') && !(process.platform==='darwin' && row[3].includes('E')));
    process.send({code:code ?? -1,cleanup},()=>{
     if(!cleanup){process.disconnect();process.stdin.destroy()}
    });
   });
  }));
 });
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
      let status: typeof GitStatus.Type | undefined
      let closed = false
      child.once("message", (message) => {
        if (Schema.is(GitStatus)(message)) status = message
      })
      child.once("close", () => {
        closed = true
      })
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
        const done = () => {
          if (status !== undefined) {
            // A live member needs the verified leader until scoped cleanup stops the group.
            if (status.cleanup || closed) resume(Effect.succeed(status.code))
          } else if (closed) resume(Effect.fail(error("Git wrapper exited without status")))
        }
        const failed = (cause: Error) => resume(Effect.fail(error(cause)))
        child.once("close", done)
        child.once("message", done)
        child.once("error", failed)
        done()
        return Effect.sync(() => {
          child.off("close", done)
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
  const identity = (worktree: Worktree) => ({
    version: 1,
    runId: options.runId,
    repoRoot: options.repoRoot,
    taskId: worktree.taskId,
    path: worktree.path,
    branch: worktree.branch,
  })
  const owner = (worktree: Worktree) => JSON.stringify(identity(worktree))
  const pendingOwner = (worktree: Worktree, baseSha: string) => JSON.stringify({ ...identity(worktree), baseSha })
  const creationMessage = (worktree: Worktree, baseSha: string) =>
    `agentrun: create ${createHash("sha256").update(pendingOwner(worktree, baseSha)).digest("hex")}`
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const refusal = (worktree: Worktree, reason: string) =>
    new GitError({
      command: "worktree ownership",
      exitCode: -1,
      stderr: `Worktree ownership is unproved for ${worktree.branch}: ${reason}.\n`
        + `Stop execution for this repository and its linked checkouts. Back up the run, Git data and workspace, including ignored files.\n`
        + `Inspect with:\n`
        + `git -C ${quote(options.repoRoot)} rev-parse --path-format=absolute --git-common-dir\n`
        + `git -C ${quote(options.repoRoot)} worktree list --porcelain\n`
        + `git -C ${quote(options.repoRoot)} show-ref --verify ${quote(`refs/heads/${worktree.branch}`)}\n`
        + `git -C ${quote(options.repoRoot)} reflog show ${quote(`refs/heads/${worktree.branch}`)}\n`
        + `git -C ${quote(worktree.path)} rev-parse --path-format=absolute --git-common-dir --symbolic-full-name HEAD\n`
        + `git -C ${quote(worktree.path)} status --porcelain=v1 --untracked-files=all --ignored\n`
        + (reason === "pending workspace is not clean"
          ? `Crash recovery cannot prove which files the hook wrote.\n`
            + `Preview untracked and ignored files with:\n`
            + `git -C ${quote(worktree.path)} clean --dry-run -d -x\n`
            + `Inspect tracked changes with:\n`
            + `git -C ${quote(worktree.path)} diff --binary\n`
            + `git -C ${quote(worktree.path)} diff --cached --binary\n`
            + `Move only confirmed disposable files to your backup. Preserve files whose source is uncertain.\n`
            + `Repeat the status command and retry resume only when it is empty. Do not force cleanup.\n`
          : "")
        + `Compare the saved run with ${quote(receipt(worktree))} and ${
          quote(`${receipt(worktree)}.pending`)
        }. Check file type and size before reading records.\n`
        + `Only after backups and proof of creation, remove confirmed disposable resources with:\n`
        + `git -C ${quote(options.repoRoot)} worktree remove ${quote(worktree.path)}\n`
        + `git -C ${quote(options.repoRoot)} branch -d ${quote(worktree.branch)}\n`
        + `If proof is missing or ordinary cleanup refuses, preserve the resources and use a different run ID. Do not force cleanup or rewrite receipts.`,
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
      || (yield* OwnershipRecords.exists(`${receipt(worktree)}.pending`).pipe(Effect.mapError(processError)))
      || (yield* matchingBranches(worktree)).length > 0
    ) {
      return yield* new GitError({
        command: "worktree ownership",
        exitCode: -1,
        stderr: `Worktree collision: ${worktree.branch}; choose a different run ID`,
      })
    }
  })
  const assertWorkspaceIdentity = Effect.fn("Worktrees.assertWorkspaceIdentity")(function*(worktree: Worktree) {
    const identity = yield* git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--symbolic-full-name",
      "HEAD",
    ], { cwd: worktree.path }).pipe(Effect.mapError(() => refusal(worktree, "workspace Git identity cannot be read")))
    const [directory, branch] = identity.split("\n")
    if (
      directory === undefined || branch !== `refs/heads/${worktree.branch}`
      || (yield* fs.realPath(directory).pipe(
          Effect.mapError(() => refusal(worktree, "repository cannot be resolved")),
        ))
        !== commonDir
    ) return yield* refusal(worktree, "workspace Git identity differs")
  })
  const inspect = Effect.fn("Worktrees.inspect")(function*(worktree: Worktree, baseSha?: string, createdHere = false) {
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
    const pending = !owned && (yield* OwnershipRecords.exists(`${file}.pending`).pipe(
      Effect.mapError(() => refusal(worktree, "pending receipt cannot be read")),
    ))
    if (owned) {
      yield* OwnershipRecords.read(file, OwnershipRecords.BranchReceipt, owner(worktree)).pipe(
        Effect.mapError(() => refusal(worktree, "creation receipt belongs to another run or is invalid")),
      )
    } else if (pending) {
      if (baseSha === undefined) return yield* refusal(worktree, "pending creation requires resume validation")
      yield* OwnershipRecords.read(
        `${file}.pending`,
        OwnershipRecords.PendingBranchReceipt,
        pendingOwner(worktree, baseSha),
      ).pipe(
        Effect.mapError(() => refusal(worktree, "pending receipt belongs to another run or base, or is invalid")),
      )
    } else if (dir || branches.length > 0) {
      return yield* refusal(worktree, "creation receipt is missing")
    }
    if (dir) {
      if (branches.length !== 1) return yield* refusal(worktree, "workspace Git identity differs")
      yield* assertWorkspaceIdentity(worktree)
    }
    if (pending && branches.length === 1 && baseSha !== undefined) {
      const ref = `refs/heads/${worktree.branch}`
      if ((yield* git(["rev-parse", "--verify", ref], repo)) !== baseSha) {
        return yield* refusal(worktree, "pending branch tip differs from the recorded base")
      }
      const history = yield* git(["reflog", "show", "--format=%H %gs", ref], repo).pipe(
        Effect.mapError(() => refusal(worktree, "pending branch creation is unproved")),
      )
      if (history !== `${baseSha} ${creationMessage(worktree, baseSha)}`) {
        return yield* refusal(worktree, "pending branch creation is unproved")
      }
      if (
        dir && !createdHere
        && (yield* git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], { cwd: worktree.path }))
          !== ""
      ) {
        return yield* refusal(worktree, "pending workspace is not clean")
      }
    }
    return { dir, branch: branches.length === 1, owned, pending }
  })
  const saveReceipt = Effect.fn("Worktrees.saveReceipt")(
    function*(worktree: Worktree, file: string, content: string, reason: string) {
      yield* Effect.gen(function*() {
        yield* OwnershipRecords.validateGenerated(content)
        yield* fs.makeDirectory(ownership, { recursive: true, mode: 0o700 })
        yield* Effect.scoped(Effect.gen(function*() {
          const temporary = yield* fs.makeTempFileScoped({ directory: ownership, prefix: ".receipt-" })
          yield* fs.chmod(temporary, 0o600)
          yield* fs.writeFileString(temporary, content)
          // An exclusive link exposes only complete proof and cannot replace another receipt.
          yield* fs.link(temporary, file)
        }))
      }).pipe(Effect.mapError(() => refusal(worktree, reason)))
    },
  )
  const promote = Effect.fn("Worktrees.promote")(function*(worktree: Worktree) {
    yield* saveReceipt(worktree, receipt(worktree), owner(worktree), "creation receipt could not be saved")
    yield* fs.remove(`${receipt(worktree)}.pending`).pipe(
      Effect.mapError(() => refusal(worktree, "pending receipt could not be retired")),
    )
  })
  const pruneMissing = Effect.fn("Worktrees.pruneMissing")(function*(worktree: Worktree) {
    if (yield* OwnershipRecords.exists(worktree.path).pipe(Effect.mapError(processError))) {
      return yield* refusal(worktree, "workspace path is no longer absent")
    }
    const parent = yield* fs.realPath(path.dirname(worktree.path)).pipe(Effect.mapError(processError))
    const canonical = path.join(parent, path.basename(worktree.path))
    const registered = yield* git(["worktree", "list", "--porcelain", "-z"], repo)
    const fields = registered.split("\0\0").map((entry) => entry.split("\0")).find((entry) =>
      entry[0] === `worktree ${worktree.path}` || entry[0] === `worktree ${canonical}`
    )
    if (fields === undefined) return
    if (!fields.includes(`branch refs/heads/${worktree.branch}`)) {
      return yield* refusal(worktree, "missing workspace registration belongs to another branch")
    }
    // Ordinary removal clears only this absent workspace's registration and respects Git locks.
    yield* git(["worktree", "remove", worktree.path], repo).pipe(
      semaphore.withPermits(1),
      Effect.mapError(() => refusal(worktree, "missing workspace registration cannot be removed; inspect its lock")),
    )
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
          const existing = yield* inspect(worktree, baseSha)
          yield* fs.makeDirectory(path.dirname(worktree.path), { recursive: true }).pipe(Effect.orDie)
          if (existing.dir) {
            if (existing.pending) yield* promote(worktree)
            return worktree
          }
          yield* onCreate?.() ?? Effect.void
          if (existing.owned) {
            yield* pruneMissing(worktree)
            yield* git(
              existing.branch
                ? ["worktree", "add", worktree.path, worktree.branch]
                : ["worktree", "add", "-b", worktree.branch, worktree.path, baseSha],
              repo,
            ).pipe(semaphore.withPermits(1))
          } else {
            const base = yield* git(["rev-parse", "--verify", `${baseSha}^{commit}`], repo)
            if (!existing.pending) {
              yield* saveReceipt(
                worktree,
                `${receipt(worktree)}.pending`,
                pendingOwner(worktree, base),
                "pending receipt could not be saved",
              )
            }
            if (existing.branch) yield* pruneMissing(worktree)
            if (!existing.branch) {
              // Git writes this witness with the ref; an intent alone never proves branch creation.
              yield* git([
                "update-ref",
                "--create-reflog",
                "-m",
                creationMessage(worktree, base),
                `refs/heads/${worktree.branch}`,
                base,
                "",
              ], repo).pipe(semaphore.withPermits(1))
            }
            yield* git(["worktree", "add", worktree.path, worktree.branch], repo).pipe(semaphore.withPermits(1))
            // Creation succeeded in this call; only recovery needs to recheck the branch tip and witness.
            yield* assertWorkspaceIdentity(worktree)
            yield* promote(worktree)
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
    const pending: Array<Worktree> = []
    for (const task of state.tasks) {
      const recorded = state.worktrees[task.id]
      const worktree = recorded === undefined ? locate(task.id) : { taskId: task.id, ...recorded }
      const existing = yield* inspect(worktree, state.baseSha)
      if (existing.pending && existing.branch) pending.push(worktree)
    }
    for (const worktree of pending) {
      const missing = !(yield* fs.exists(worktree.path).pipe(Effect.mapError(processError)))
      if (missing) {
        yield* fs.makeDirectory(path.dirname(worktree.path), { recursive: true }).pipe(Effect.mapError(processError))
        yield* pruneMissing(worktree)
        yield* git(["worktree", "add", worktree.path, worktree.branch], repo).pipe(semaphore.withPermits(1))
      }
      yield* inspect(worktree, state.baseSha, missing)
      yield* promote(worktree)
    }
    const actions: Array<Reconciled> = []
    for (const task of state.tasks) {
      const taskId = task.id
      const status = state.status[taskId]
      const recorded = state.worktrees[taskId]
      const worktree = recorded === undefined ? locate(taskId) : { taskId, ...recorded }
      const dir = yield* fs.exists(worktree.path).pipe(Effect.orDie)
      const branch = yield* branchExists(worktree.branch)
      if (status?._tag === "pending" && branch) {
        if (!dir) yield* pruneMissing(worktree)
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
          yield* pruneMissing(worktree)
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
