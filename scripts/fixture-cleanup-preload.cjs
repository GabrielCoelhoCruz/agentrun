const fs = require("node:fs")
const path = require("node:path")
const { syncBuiltinESMExports } = require("node:module")
const root = process.env.TEST_RECORDS
if (root && process.env.AGENTRUN_CLEANUP_PROBE) {
  fs.appendFileSync(
    path.join(root, "probe-processes.jsonl"),
    JSON.stringify({ pid: process.pid, argv: process.argv }) + "\n",
  )
  if (process.env.AGENTRUN_CLEANUP_PROBE === "lease-timeout" && process.argv[1]?.endsWith("/fixtures/dist/entry.mjs")) {
    fs.writeFileSync(path.join(root, "probe-contender-stopped"), String(process.pid))
    process.kill(process.pid, "SIGSTOP")
  }
  const write = fs.writeFileSync
  fs.writeFileSync = function(file, ...args) {
    if (
      ["wait", "slow-cleanup"].includes(process.env.AGENTRUN_CLEANUP_PROBE)
      && String(file) === path.join(root, "child-task0")
    ) {
      return write.call(this, `${file}.hidden`, ...args)
    }
    return write.call(this, file, ...args)
  }
  syncBuiltinESMExports()
}

if (process.env.AGENTRUN_CLEANUP_PROBE === "slow-cleanup" && !root) {
  const childProcess = require("node:child_process")
  const spawnSync = childProcess.spawnSync
  let delayed = false
  childProcess.spawnSync = function(command, args, options) {
    const result = spawnSync.call(this, command, args, options)
    if (
      !delayed && command === "ps" && args?.includes("pgid=,command=")
      && String(result.stdout).includes("/test/fixtures/dist/entry.mjs")
    ) {
      delayed = true
      fs.writeFileSync(path.join(process.env.AGENTRUN_TEST_EVIDENCE, "cleanup-delayed"), String(process.pid))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 11000)
      return spawnSync.call(this, command, args, options)
    }
    return result
  }
  syncBuiltinESMExports()
}
