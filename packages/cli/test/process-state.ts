import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

// Test proof uses OS state: a zombie cannot run, although kill(pid, 0) succeeds.
export const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid child PID")
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8" })
  const directory = process.env.TEST_RECORDS ?? process.env.AGENTRUN_TEST_EVIDENCE
  if (directory) {
    appendFileSync(
      join(directory, "process-states.jsonl"),
      JSON.stringify({ pid, code: result.status, table: result.stdout }) + "\n",
    )
  }
  if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return false
  if (result.status !== 0) throw new Error("Cannot inspect child process state")
  const rows = result.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/))
  if (rows.some((row) => row.length !== 4 || Number(row[0]) !== pid || !row[3])) {
    throw new Error("Invalid child process state")
  }
  return rows.some((row) => !row[3]?.startsWith("Z"))
}
