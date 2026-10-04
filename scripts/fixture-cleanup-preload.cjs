const fs = require("node:fs")
const path = require("node:path")
const { syncBuiltinESMExports } = require("node:module")
const root = process.env.TEST_RECORDS
if (root && process.env.AGENTRUN_CLEANUP_PROBE) {
  fs.appendFileSync(
    path.join(root, "probe-processes.jsonl"),
    JSON.stringify({ pid: process.pid, argv: process.argv }) + "\n",
  )
  const write = fs.writeFileSync
  fs.writeFileSync = function(file, ...args) {
    if (process.env.AGENTRUN_CLEANUP_PROBE === "wait" && String(file) === path.join(root, "child-task0")) {
      return write.call(this, `${file}.hidden`, ...args)
    }
    return write.call(this, file, ...args)
  }
  syncBuiltinESMExports()
}
