const fs = require("node:fs")
const path = require("node:path")
const original = global.setTimeout
global.setTimeout = function(callback, delay, ...args) {
  if (process.argv[1]?.endsWith("/fixtures/dist/entry.mjs") && callback.name === "draw" && delay === 100) {
    fs.appendFileSync(
      path.join(process.env.TEST_RECORDS, "draw-delay.jsonl"),
      JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        originalDelay: delay,
        observedDelay: 1000,
        callback: callback.name,
      }) + "\n",
    )
    return original(callback, 1000, ...args)
  }
  return original(callback, delay, ...args)
}
