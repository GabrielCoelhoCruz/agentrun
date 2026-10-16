import { createServer } from "node:http"

const notes = new Map<string, string>()
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json")
  if (request.url === "/ready") {
    response.end(JSON.stringify({ ready: true, schema: 1 }))
    return
  }
  if (request.method === "POST" && request.url === "/notes") {
    let body = ""
    for await (const chunk of request) body += String(chunk)
    const value: unknown = JSON.parse(body)
    if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string") {
      response.writeHead(400).end(JSON.stringify({ error: "text is required" }))
      return
    }
    const id = String(notes.size + 1)
    notes.set(id, value.text)
    response.writeHead(201).end(JSON.stringify({ id, text: value.text }))
    return
  }
  const id = request.url?.match(/^\/notes\/(\d+)$/)?.[1]
  const text = id === undefined ? undefined : notes.get(id)
  if (text === undefined) response.writeHead(404).end(JSON.stringify({ error: "not found" }))
  else response.end(JSON.stringify({ id, text }))
})
server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (address !== null && typeof address === "object") {
    process.stdout.write(`${JSON.stringify({ port: address.port, pid: process.pid })}\n`)
  }
})
process.on("SIGTERM", () => server.close(() => process.exit(0)))
