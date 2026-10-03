import { getAgentDir, ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent"
import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { lockUtility } from "./RunLock.js"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const versionSchema = Schema.Struct({ version: Schema.String })
const claudePath = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"))
const claudeVersion = () =>
  Schema.decodeUnknownSync(versionSchema)(JSON.parse(readFileSync(join(claudePath, "package.json"), "utf8"))).version

export const diagnostics = Effect.fn("diagnostics")(function*(cwd: string) {
  const git = yield* Effect.tryPromise(() => exec("git", ["--version"], { cwd, timeout: 5000 })).pipe(Effect.result)
  const repo = yield* Effect.tryPromise(() => exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 }))
    .pipe(Effect.result)
  const auth = yield* Effect.tryPromise(async () => {
    const legacy = join(claudePath, "cli.js")
    const js = existsSync(legacy)
    const systemReport = process.report.getReport()
    const glibc = "header" in systemReport && typeof systemReport.header === "object" && systemReport.header !== null
      && "glibcVersionRuntime" in systemReport.header
    const suffix = process.platform === "linux" && !glibc ? "-musl" : ""
    const executable = js ? process.execPath : require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/claude`,
      { paths: [claudePath] },
    )
    try {
      return (await exec(executable, [...(js ? [legacy] : []), "auth", "status", "--json"], {
        cwd,
        timeout: 10000,
        maxBuffer: 65536,
      })).stdout
    } catch (error) {
      // The native CLI returns valid loggedIn:false JSON with exit 1.
      if (
        error instanceof Error && "code" in error && error.code === 1 && "stdout" in error
        && typeof error.stdout === "string"
      ) return error.stdout
      throw error
    }
  }).pipe(
    Effect.flatMap((stdout) =>
      Effect.try(() => Schema.decodeUnknownSync(Schema.Struct({ loggedIn: Schema.Boolean }))(JSON.parse(stdout)))
    ),
    Effect.result,
  )
  const claude = auth._tag === "Success"
    ? { status: auth.success.loggedIn ? "available" : "missing", reason: "Bundled CLI auth status; no prompt sent" }
    : { status: "unknown", reason: "Bundled CLI auth status did not provide a usable result; no prompt sent" }
  const pi = yield* Effect.tryPromise(async () => {
    const dir = getAgentDir()
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
    })
    const available = runtime.getAvailableSnapshot().length > 0
    return {
      status: available ? "available" : "missing",
      reason: "SDK configured-auth snapshot; token validity is not verified",
    }
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({ status: "unknown", reason: "SDK auth snapshot unavailable; no credentials changed" })
    ),
  )
  const utility = lockUtility()
  const probe = utility === undefined
    ? undefined
    : yield* Effect.tryPromise(() =>
      exec(
        utility,
        process.platform === "darwin" ? ["-k", "-t", "0", "/dev/null", process.execPath, "-e", ""] : ["--version"],
        { cwd, timeout: 5000 },
      )
    ).pipe(Effect.result)
  const lock = {
    ok: probe?._tag === "Success",
    utility: utility ?? "unsupported",
    reason: utility === undefined
      ? "Unsupported OS; requires macOS lockf or Linux flock"
      : probe?._tag === "Success"
      ? "Supported kernel lock utility is available"
      : "Required kernel lock utility is unavailable",
  }
  const runtime = { ok: process.versions.node.split(".")[0] === "24", version: process.version }
  return {
    complete: runtime.ok && lock.ok && git._tag === "Success" && repo._tag === "Success"
      && claude.status === "available" && pi.status === "available",
    lock,
    runtime: { ok: process.versions.node.split(".")[0] === "24", version: process.version },
    git: {
      ok: git._tag === "Success" && repo._tag === "Success",
      version: git._tag === "Success" ? git.success.stdout.trim() : "unavailable",
    },
    providers: [
      { id: "claude-code", version: claudeVersion(), auth: claude },
      { id: "pi", version: VERSION, auth: pi },
    ],
  }
})
