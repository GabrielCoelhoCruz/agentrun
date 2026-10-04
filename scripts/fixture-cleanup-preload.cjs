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
    if (process.env.AGENTRUN_CLEANUP_PROBE === "wait" && String(file) === path.join(root, "child-task0")) {
      return write.call(this, `${file}.hidden`, ...args)
    }
    return write.call(this, file, ...args)
  }
  syncBuiltinESMExports()
}
