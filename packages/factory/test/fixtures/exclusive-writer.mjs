import crypto from "node:crypto"
import fs from "node:fs"
import { registerHooks, syncBuiltinESMExports } from "node:module"
import { join } from "node:path"

const [directory, mode] = process.argv.slice(2)
registerHooks({
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
if (mode === "collision") crypto.randomBytes = () => Buffer.from("0123456789abcdef", "hex")
if (mode === "fail") {
  fs.writeFileSync = () => {
    throw new Error("injected write failure")
  }
}
if (mode === "swap") {
  const fsync = fs.fsyncSync
  let swapped = false
  fs.fsyncSync = (fd) => {
    fsync(fd)
    if (swapped) return
    swapped = true
    fs.renameSync(join(directory, "artifacts"), join(directory, "outside"))
    fs.symlinkSync(join(directory, "outside"), join(directory, "artifacts"), "dir")
  }
}
if (mode === "crash") {
  fs.linkSync = () => {
    process.kill(process.pid, "SIGKILL")
  }
}
if (mode === "pause") {
  const link = fs.linkSync
  fs.linkSync = (...args) => {
    fs.writeFileSync(join(directory, "paused"), args[0])
    const deadline = Date.now() + 20000
    while (!fs.existsSync(join(directory, "release"))) {
      if (Date.now() > deadline) throw new Error("Writer was not released")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    return link(...args)
  }
}
syncBuiltinESMExports()
const { writeExclusive } = await import("../../src/Files.ts")
try {
  writeExclusive(join(directory, ...(mode === "swap" ? ["artifacts"] : []), "result.json"), "complete")
  console.log(JSON.stringify({ ok: true }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }))
  process.exitCode = 1
}
