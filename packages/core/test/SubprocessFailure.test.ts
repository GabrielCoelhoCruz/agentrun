import { expect, test } from "vitest"
import { subprocessFailure } from "../src/SubprocessFailure.js"

test.each([23, "ENOENT", "EACCES", "ETIMEDOUT", "ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"])(
  "subprocess diagnostics retain native code %s without exception contents",
  (code) => {
    const diagnostic = subprocessFailure({
      code,
      signal: "SIGTERM",
      killed: true,
      message: "command /private/fixture token=private-token",
      cmd: "/private/fixture --secret=private-token",
      stdout: "private process table",
      stderr: "Permission denied: /private/fixture TOKEN=private-token\n",
    }, 5000)
    expect(JSON.parse(diagnostic)).toMatchObject({
      code,
      signal: "SIGTERM",
      killed: true,
      timeoutMs: 5000,
      stderr: { present: true, context: ["permission denied"] },
    })
    expect(diagnostic).not.toMatch(/private|TOKEN|command|process table/)
    expect(diagnostic.length).toBeLessThan(800)
  },
)

test("subprocess diagnostics do not label every killed child as timed out", () => {
  const diagnostic = JSON.parse(subprocessFailure({ code: "ABORT_ERR", killed: true }, 30000))
  expect(diagnostic.code).toBe("ABORT_ERR")
  expect(diagnostic.timeoutMs).toBe(30000)
  expect(diagnostic).not.toHaveProperty("timedOut")
})

test.each([undefined, null, "private exception", { code: "PRIVATE_TOKEN", signal: "PRIVATE_SIGNAL" }])(
  "subprocess diagnostics handle absent or unrecognized native fields",
  (cause) => {
    const diagnostic = subprocessFailure(cause, 30000)
    expect(JSON.parse(diagnostic)).toMatchObject({ code: null, signal: null, killed: null, timeoutMs: 30000 })
    expect(diagnostic).not.toMatch(/private/i)
  },
)

test("subprocess stderr context is bounded and omits arbitrary contents", () => {
  const diagnostic = subprocessFailure({
    stderr: `private-token /private/path ${"x".repeat(100000)} Permission denied`,
    env: { PRIVATE_TOKEN: "private-token" },
    argv: ["--secret=private-token"],
  }, 5000)
  expect(JSON.parse(diagnostic).stderr).toEqual({ present: true, context: [], truncated: true })
  expect(diagnostic).not.toMatch(/private|Permission|xxx/)
  expect(diagnostic.length).toBeLessThan(800)
})
