const childProcess = require("node:child_process")
const fs = require("node:fs")
const original = childProcess.spawnSync
childProcess.spawnSync = function(command, args, options) {
  if (command === "python3" && args?.some((arg) => arg.endsWith("/terminal-demo.py"))) {
    const start = Date.now()
    const result = original(command, args, { ...options, killSignal: "SIGKILL" })
    fs.writeFileSync(`${process.env.AGENTRUN_TEST_EVIDENCE}/outer-deadline.json`, JSON.stringify({
      timeout: options.timeout,
      elapsed: Date.now() - start,
      error: result.error?.code,
      signal: result.signal,
    }))
    return result
  }
  return original(command, args, options)
}
require("node:module").syncBuiltinESMExports()
