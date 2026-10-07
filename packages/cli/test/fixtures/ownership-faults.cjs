// Test-only filesystem injection. Loaded by Node, never by application code.
const fs = require("node:fs")
const { syncBuiltinESMExports } = require("node:module")
const target = process.env.AGENTRUN_RECORD_TARGET
const fault = process.env.AGENTRUN_RECORD_FAULT
const marker = process.env.AGENTRUN_RECORD_MARKER
if (target && fault && marker) {
  const snapshot = () => {
    const stat = fs.lstatSync(target)
    return {
      mode: stat.mode,
      size: stat.size,
      ino: stat.ino,
      dev: stat.dev,
      bytes: stat.isFile()
        ? require("node:crypto").createHash("sha256").update(fs.readFileSync(target)).digest("hex")
        : null,
    }
  }
  let injected = false
  const inject = () => {
    if (injected) return
    injected = true
    if (fault === "replace-before-open" || fault === "replace-after-open") {
      fs.renameSync(target, target + ".original")
      fs.copyFileSync(target + ".original", target)
    }
    if (fault === "device-before-open") {
      fs.renameSync(target, target + ".original")
      fs.symlinkSync("/dev/null", target)
    }
    if (fault === "grow") fs.appendFileSync(target, " ")
    if (fault === "truncate") fs.truncateSync(target, 1)
    if (fault === "same-size") {
      const bytes = fs.readFileSync(target)
      // Keep bytes valid and identical: only an observed metadata change proves refusal.
      fs.writeFileSync(target, bytes)
      const stat = fs.statSync(target)
      fs.utimesSync(target, stat.atime, new Date(stat.mtimeMs + 1000))
    }
    fs.writeFileSync(marker, JSON.stringify({ fault, target, pid: process.pid, after: snapshot() }))
  }
  const open = fs.promises.open
  fs.promises.open = async function(path, ...args) {
    if (String(path) !== target) return open.call(this, path, ...args)
    if (fault.endsWith("before-open")) inject()
    const handle = await open.call(this, path, ...args)
    const read = handle.read.bind(handle)
    handle.read = async function(...args) {
      if (!injected) inject()
      if (fault === "read-error") throw new Error("PRIVATE_RECORD_CONTENT")
      if (fault === "premature-eof") return { bytesRead: 0, buffer: args[0] }
      if (fault === "short-read") args[2] = Math.min(args[2], 3)
      return read(...args)
    }
    return handle
  }
  syncBuiltinESMExports()
}
