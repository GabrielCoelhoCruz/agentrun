import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"

const artifacts = process.env.FACTORY_ARTIFACT_DIR
assert.ok(artifacts, "FACTORY_ARTIFACT_DIR is required")
const database = join(artifacts, "notes.sqlite")
const children = []
const transcript = []
const start = async () => {
  const child = spawn(process.execPath, ["server.ts"], {
    env: { ...process.env, NOTES_DB: database },
    stdio: ["ignore", "pipe", "inherit"],
  })
  children.push(child)
  const lines = createInterface({ input: child.stdout })
  const [line] = await Promise.race([
    once(lines, "line"),
    once(child, "exit").then(([code]) => {
      throw new Error(`Server exited before readiness: ${code}`)
    }),
  ])
  const address = JSON.parse(line)
  assert.equal(address.pid, child.pid)
  const origin = `http://127.0.0.1:${address.port}`
  const readiness = await fetch(`${origin}/ready`).then((response) => response.json())
  assert.deepEqual(readiness, { ready: true, schema: 1 })
  transcript.push({ event: "ready", ...address, readiness })
  return { child, origin }
}
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const [code] = await exited
  assert.equal(code, 0)
  transcript.push({ event: "stopped", pid: child.pid })
}
let outcome = "fail"
try {
  const first = await start()
  const response = await fetch(`${first.origin}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "A note that survives restart" }),
  })
  assert.equal(response.status, 201)
  const created = await response.json()
  assert.equal(created.text, "A note that survives restart")
  transcript.push({ event: "created", note: created })
  await stop(first.child)
  const second = await start()
  assert.notEqual(first.child.pid, second.child.pid)
  const read = await fetch(`${second.origin}/notes/${created.id}`)
  assert.equal(read.status, 200, "The created note must survive a server restart")
  const restored = await read.json()
  assert.deepEqual(restored, created)
  transcript.push({ event: "read-after-restart", note: restored })
  await stop(second.child)
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1)
    assert.equal(db.prepare("SELECT text FROM notes WHERE id = ?").get(Number(created.id)).text, created.text)
    transcript.push({ event: "migration-verified", version: 1 })
  } finally {
    db.close()
  }
  outcome = "pass"
} finally {
  for (const child of children) await stop(child)
  await writeFile(join(artifacts, "journey.json"), JSON.stringify(transcript, null, 2))
  await writeFile(
    process.env.FACTORY_RESULT,
    JSON.stringify({
      version: 1,
      attemptId: process.env.FACTORY_ATTEMPT_ID,
      candidate: process.env.FACTORY_CANDIDATE,
      checkId: process.env.FACTORY_CHECK_ID,
      criteria: [{ id: "persisted-note", outcome, artifacts: ["journey.json"] }],
    }),
  )
}
