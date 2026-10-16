import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const probe = fileURLToPath(new URL("./fixtures/record-reader.mjs", import.meta.url))
const run = (target: string, fault: string) => {
  const directory = mkdtempSync(join(tmpdir(), "factory-record-read-"))
  try {
    const result = spawnSync(process.execPath, [probe, directory, target, fault], {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    })
    expect(result.error?.message, result.stdout + result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (
  const target of [
    "owner.json",
    "result.json",
    "command-group.json",
    "started.json",
    "receipt",
    "reservation",
    "retry",
    "state",
    "journal",
  ]
) {
  test.each(["fifo-swap", "grow-before-open", "grow-during-read"])(
    `factory ${target} refuses %s within the read deadline`,
    (fault) => {
      const result = run(target, fault)
      expect(result.injected).toBe(true)
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/regular file|bounded record/i)
    },
    10000,
  )
}

test.each(["fifo", "socket", "device", "directory", "symlink", "temporary", "oversize"])(
  "factory reader refuses %s",
  (fault) => {
    const result = run("owner.json", fault)
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/regular file|temporary|bounded record/i)
  },
  10000,
)

test.each(["limit", "empty"])("factory reader accepts %s bytes", (fault) => {
  expect(run("owner.json", fault)).toEqual({ injected: false, accepted: true, bytes: fault === "limit" ? 16777216 : 0 })
}, 10000)
