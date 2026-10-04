import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { spawn } from "node:child_process"
import { constants } from "node:os"

export const workerBashOperationsFor = (shell = "bash"): BashOperations => ({
  exec: (command, cwd, options) =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error("aborted"))
      const child = spawn(shell, ["-c", command], {
        cwd,
        detached: false,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const abort = () => child.kill("SIGTERM")
      options.signal?.addEventListener("abort", abort, { once: true })
      let timedOut = false
      const timer = options.timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
      }, options.timeout * 1000)
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
      }
      child.stdout.on("data", options.onData)
      child.stderr.on("data", options.onData)
      child.once("error", (error) => {
        cleanup()
        reject(error)
      })
      child.once("exit", (code, signal) => {
        cleanup()
        if (options.signal?.aborted) reject(new Error("aborted"))
        else if (timedOut) reject(new Error(`timeout:${options.timeout}`))
        else resolve({ exitCode: code ?? (signal === null ? null : 128 + constants.signals[signal]) })
      })
    }),
})
export const workerBashOperations = workerBashOperationsFor()
