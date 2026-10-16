import { Schema } from "effect"
import { spawn } from "node:child_process"
import { CommandSpec } from "./Domain.js"

// Retain the token-bearing group leader until cleanup has stopped its descendants.
setInterval(() => {}, 1000)
process.on("SIGTERM", () => {})
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (data: string) => {
  input += data
  if (input.length > 1024 * 1024) process.exit(1)
})
process.stdin.once("end", () => {
  if (input.trim() === "") process.exit(0)
  const command = Schema.decodeUnknownSync(CommandSpec, { onExcessProperty: "error" })(JSON.parse(input))
  const child = spawn(command.argv[0], command.argv.slice(1), {
    cwd: command.cwd,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if (process.connected) process.send?.("started", () => {})
  const report = (exitCode: number | null, signal: string | null) => {
    if (process.connected) process.send?.({ exitCode, signal }, () => {})
  }
  child.once("error", () => report(-1, null))
  child.once("exit", report)
})
process.stdin.resume()
