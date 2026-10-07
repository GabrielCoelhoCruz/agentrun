import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createHash } from "node:crypto"
import { GitError } from "./domain/Errors.js"

export const repoIdentity = Effect.fn("repoIdentity")(function*(repoRoot: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = Effect.fn("RepoHash.git")(function*(args: ReadonlyArray<string>, { cwd }: { readonly cwd: string }) {
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

  const commonDir = yield* git(["rev-parse", "--git-common-dir"], { cwd: repoRoot })
  const realPath = yield* fs.realPath(path.resolve(repoRoot, commonDir)).pipe(
    Effect.mapError((error) =>
      new GitError({ command: "realpath git-common-dir", exitCode: -1, stderr: error.message })
    ),
  )
  return { commonDir: realPath, hash: createHash("sha256").update(realPath).digest("hex").slice(0, 12) }
})

export const repoHash = (repoRoot: string) => repoIdentity(repoRoot).pipe(Effect.map((identity) => identity.hash))
