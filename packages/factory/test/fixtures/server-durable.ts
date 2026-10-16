import { createServer } from "node:http"
import { DatabaseSync } from "node:sqlite"

const database = process.env.NOTES_DB
if (database === undefined) throw new Error("NOTES_DB is required")
const db = new DatabaseSync(database)
db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL); PRAGMA user_version = 1")
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json")
  if (request.url === "/ready") {
    response.end(JSON.stringify({ ready: true, schema: db.prepare("PRAGMA user_version").get()?.user_version }))
    return
  }
  if (request.method === "POST" && request.url === "/notes") {
    let body = ""
    for await (const chunk of request) body += String(chunk)
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: "invalid JSON" }))
      return
    }
    if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string") {
      response.writeHead(400).end(JSON.stringify({ error: "text is required" }))
      return
    }
    const inserted = db.prepare("INSERT INTO notes (text) VALUES (?)").run(value.text)
    response.writeHead(201).end(JSON.stringify({ id: String(inserted.lastInsertRowid), text: value.text }))
    return
  }
  const id = request.url?.match(/^\/notes\/(\d+)$/)?.[1]
  const row = id === undefined ? undefined : db.prepare("SELECT text FROM notes WHERE id = ?").get(Number(id))
  if (row === undefined) response.writeHead(404).end(JSON.stringify({ error: "not found" }))
  else response.end(JSON.stringify({ id, text: row.text }))
})
server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (address !== null && typeof address === "object") {
    process.stdout.write(`${JSON.stringify({ port: address.port, pid: process.pid })}\n`)
  }
})
process.on("SIGTERM", () =>
  server.close(() => {
    db.close()
    process.exit(0)
  }))
