import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from "node:module"
import { createServer } from "node:net"
import { join } from "node:path"

const [directory, target, fault] = process.argv.slice(2)
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context)
    return url.endsWith(".ts")
      ? { ...loaded, format: "module", source: stripTypeScriptTypes(String(loaded.source), { mode: "transform" }) }
      : loaded
  },
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        try {
          return next(specifier.slice(0, -3) + ".ts", context)
        } catch {}
      }
      throw error
    }
  },
})
const repo = join(directory, "repo")
fs.mkdirSync(repo)
execFileSync("git", ["init", "-q", repo])
const commonDir = fs.realpathSync(join(repo, ".git"))
let file = join(directory, target.includes(".") ? target : "owner.json")
const expected = JSON.stringify({ version: 1, runId: "probe", repoRoot: repo })
if (target === "reservation") {
  file = join(commonDir, "agentrun/ownership/runs/probe/owner.json")
  const state = join(repo, ".agentrun/runs/probe/state.json")
  fs.mkdirSync(join(state, ".."), { recursive: true })
  fs.writeFileSync(state, "{}")
}
if (target === "state") file = join(repo, ".agentrun/runs/probe/state.json")
if (target === "receipt") file = join(directory, "result.json")
if (target === "journal") {
  const hash = createHash("sha256").update(commonDir).digest("hex").slice(0, 12)
  file = join(directory, ".agentrun/git", hash, "probe/999999.json")
}
fs.mkdirSync(join(file, ".."), { recursive: true })
fs.writeFileSync(file, target === "journal" ? "a".repeat(32) : expected)
let socket
if (["fifo", "socket", "directory", "symlink", "device"].includes(fault)) {
  fs.unlinkSync(file)
  if (fault === "fifo") execFileSync("mkfifo", [file])
  if (fault === "socket") {
    socket = createServer()
    await new Promise((done) => socket.listen(file, done))
  }
  if (fault === "directory") fs.mkdirSync(file)
  if (fault === "symlink") fs.symlinkSync("missing", file)
  if (fault === "device") file = "/dev/null"
}
if (fault === "temporary") {
  const temporary = join(directory, ".owner.json.partial-0123456789abcdef")
  fs.renameSync(file, temporary)
  file = temporary
}
if (["limit", "oversize", "empty"].includes(fault)) {
  fs.truncateSync(file, fault === "empty" ? 0 : 16777216 + Number(fault === "oversize"))
}
let injected = false
const inject = () => {
  if (injected) return
  injected = true
  if (fault === "fifo-swap") {
    fs.renameSync(file, file + ".original")
    execFileSync("mkfifo", [file])
  } else fs.truncateSync(file, 32 * 1024 * 1024)
}
const lstat = fs.lstatSync
fs.lstatSync = (path, ...args) => {
  const stat = lstat(path, ...args)
  if (path === file && args[0]?.throwIfNoEntry === undefined && ["fifo-swap", "grow-before-open"].includes(fault)) {
    inject()
  }
  return stat
}
const asyncLstat = fsp.lstat.bind(fsp)
fsp.lstat = async (path, ...args) => {
  const stat = await asyncLstat(path, ...args)
  if (path === file && ["fifo-swap", "grow-before-open"].includes(fault)) inject()
  return stat
}
const readFile = fs.readFileSync
fs.readFileSync = (path, ...args) => {
  if (path === file && fault === "grow-during-read") inject()
  return readFile(path, ...args)
}
const open = fsp.open.bind(fsp)
fsp.open = async (path, ...args) => {
  const handle = await open(path, ...args)
  if (path === file && fault === "grow-during-read") {
    const read = handle.read.bind(handle)
    handle.read = (...args) => {
      inject()
      return read(...args)
    }
  }
  return handle
}
syncBuiltinESMExports()
const { Effect } = await import("effect")
const { NodeServices } = await import("@effect/platform-node")
const files = await import("../../src/Files.ts")
const evaluate = async (value) => Effect.isEffect(value) ? Effect.runPromise(value) : await value
let result
try {
  let bytes
  if (target === "receipt") {
    const { receipt } = await import("../../src/Processes.ts")
    await evaluate(receipt({ directory }, "attempt"))
  } else if (target === "reservation") {
    const { cleanupExecutor } = await import("../../src/Stages.ts")
    await Effect.runPromise(
      cleanupExecutor({}, { repoRoot: repo, commonDir }, { executorRunId: "probe" }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    )
  } else if (target === "state") {
    const { StateStore } = await import("../../../core/src/StateStore.ts")
    await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* StateStore).load("probe")
      }).pipe(
        Effect.provide(StateStore.layerFile({ repoRoot: repo })),
        Effect.provide(NodeServices.layer),
      ),
    )
  } else if (target === "journal") {
    const { Worktrees } = await import("../../../core/src/Worktrees.ts")
    await Effect.runPromise(
      Effect.gen(function*() {
        return yield* (yield* Worktrees).recoverProcesses
      }).pipe(
        Effect.provide(Worktrees.layer({ repoRoot: repo, home: directory, runId: "probe" })),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  } else if (target === "retry") await evaluate(files.writeExclusive(file, expected))
  else bytes = await evaluate(files.readBytes(file))
  result = { injected, accepted: true, ...(bytes === undefined ? {} : { bytes: bytes.length }) }
} catch (error) {
  result = { injected, accepted: false, message: error.issue ?? error.stderr ?? error.message ?? String(error) }
}
if (socket) await new Promise((done) => socket.close(done))
console.log(JSON.stringify(result))
