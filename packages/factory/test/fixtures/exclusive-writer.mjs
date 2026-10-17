import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import { registerHooks, syncBuiltinESMExports } from "node:module"
import { basename, dirname, join } from "node:path"

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
if (mode === "collision-once") {
  const random = crypto.randomBytes
  let first = true
  crypto.randomBytes = (...args) => {
    if (!first) return random(...args)
    first = false
    return Buffer.from("0123456789abcdef", "hex")
  }
}
if (mode === "observe-sync") {
  const fsync = fs.fsyncSync
  fs.fsyncSync = (fd) => {
    fsync(fd)
    if (!fs.fstatSync(fd).isDirectory()) return
    const temporary = fs.readdirSync(directory).find((name) => name.startsWith(".result.json.partial-"))
    console.log(JSON.stringify({
      published: fs.readFileSync(join(directory, "result.json"), "utf8"),
      temporary: temporary === undefined ? null : fs.readFileSync(join(directory, temporary), "utf8"),
    }))
  }
}
if (mode === "fail-directory-sync" || mode === "fail-temporary-unlink") {
  const failAfterAcceptance = (code) => {
    const read = fs.readFileSync(join(directory, "result.json"), "utf8")
    const other = spawnSync(process.execPath, [process.argv[1], directory, "accept"], {
      encoding: "utf8",
      timeout: 30000,
    })
    console.log(JSON.stringify({ read, accepted: other.status === 0 }))
    throw Object.assign(new Error(`injected ${code}`), { code })
  }
  if (mode === "fail-directory-sync") {
    const fsync = fs.fsyncSync
    fs.fsyncSync = (fd) => fs.fstatSync(fd).isDirectory() ? failAfterAcceptance("EIO") : fsync(fd)
  } else {
    const unlink = fs.unlinkSync
    fs.unlinkSync = (path) =>
      basename(path).startsWith(".result.json.partial-")
        ? failAfterAcceptance("EBUSY")
        : unlink(path)
  }
}
if (mode.startsWith("publish-")) {
  const link = fs.linkSync
  fs.linkSync = (source, target) => {
    const parent = dirname(target)
    const component = mode === "publish-symlink-root"
      ? join(directory, "owned")
      : mode === "publish-symlink-ancestor"
      ? join(directory, "owned/artifacts")
      : parent
    fs.writeFileSync(join(parent, "user.txt"), "user-owned bytes")
    if (mode.startsWith("publish-existing-")) {
      fs.writeFileSync(target, mode === "publish-existing-same" ? "complete" : "user-owned artifact")
    }
    fs.renameSync(component, join(directory, "outside"))
    if (mode === "publish-directory") {
      fs.mkdirSync(component)
      link(join(directory, "outside", basename(source)), source)
      fs.writeFileSync(join(component, "user.txt"), "user-owned bytes")
    } else {
      fs.symlinkSync(join(directory, "outside"), component, "dir")
    }
    link(source, target)
    if (mode === "publish-replacement") {
      fs.unlinkSync(target)
      fs.writeFileSync(target, "user-owned artifact")
    }
  }
}
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
  const root = mode.startsWith("publish-") ? join(directory, "owned") : directory
  const components = mode.startsWith("publish-") ? ["artifacts", "nested"] : mode === "swap" ? ["artifacts"] : []
  await writeExclusive(join(root, ...components, "result.json"), "complete", root)
  console.log(JSON.stringify({ ok: true }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }))
  process.exitCode = 1
}
