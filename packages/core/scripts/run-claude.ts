import { ClaudeCode } from "@agentrun/core"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Option, Stream } from "effect"
import { appendFileSync } from "node:fs"

const program = Effect.gen(function*() {
  const prompt = process.argv[2]
  if (!prompt) return yield* Effect.die("Usage: node scripts/run-claude.ts <prompt> [raw-log] [max-turns]")
  const rawLog = process.argv[3]
  const limit = process.argv[4]
  const maxTurns = limit === undefined ? Option.none<number>() : Option.some(Number(limit))
  if (Option.isSome(maxTurns) && (!Number.isInteger(maxTurns.value) || maxTurns.value < 1)) {
    return yield* Effect.die("max-turns must be a positive integer")
  }
  const fs = yield* FileSystem.FileSystem
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "agentrun-claude-" })
  yield* Effect.sync(() => console.error(JSON.stringify({ cwd, pid: process.pid })))
  const recordedQuery: typeof query = new Proxy(query, {
    apply: (_target, _receiver, args: ReadonlyArray<Parameters<typeof query>[0]>) => {
      const params = args[0]
      if (params === undefined) throw new Error("Missing query input")
      const handle = query(params)
      return Object.assign(
        (async function*() {
          for await (const message of handle) {
            if (rawLog !== undefined) appendFileSync(rawLog, `${JSON.stringify(message)}\n`, { mode: 0o600 })
            yield message
          }
        })(),
        { close: () => handle.close() },
      )
    },
  })
  const adapter = ClaudeCode.make({ query: recordedQuery })
  yield* adapter.run({ prompt, cwd, maxTurns, maxBudgetUsd: Option.none(), model: Option.none() }).pipe(
    Stream.runForEach((event) => Effect.sync(() => console.log(JSON.stringify(event)))),
  )
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
