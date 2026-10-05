const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const demo = path.resolve(__dirname, "../packages/cli/test/terminal-demo.py")
const python = process.env.AGENTRUN_TERMINAL_PYTHON ?? "python3"
const original = childProcess.spawnSync
childProcess.spawnSync = function(command, args, options) {
  if (command === python && args?.[0] === demo) {
    fs.writeFileSync(
      `${process.env.AGENTRUN_TEST_EVIDENCE}/launch-intent.json`,
      JSON.stringify({
        command,
        args,
        nodeParent: process.pid,
        fixture: args[2],
        nonce: options.env.AGENTRUN_TERMINAL_NONCE,
      }),
    )
    const start = Date.now()
    const result = original(command, args, options)
    fs.writeFileSync(
      `${process.env.AGENTRUN_TEST_EVIDENCE}/outer-deadline.json`,
      JSON.stringify({
        timeout: options.timeout,
        elapsed: Date.now() - start,
        error: result.error?.code,
        signal: result.signal,
      }),
    )
    return result
  }
  return original(command, args, options)
}
require("node:module").syncBuiltinESMExports()
