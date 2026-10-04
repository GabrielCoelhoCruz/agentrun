import { diagnostics } from "@agentrun/core"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { CliFailure, doctor, teardown } from "../../src/index.js"
const scenario = process.argv[2]
const report: Effect.Success<ReturnType<typeof diagnostics>> = {
  complete: scenario === "ready",
  runtime: { ok: scenario !== "runtime", version: "v24.test" },
  git: { ok: true, version: "git test" },
  lock: { ok: scenario !== "lock", utility: "test kernel lock", reason: "injected supported diagnostics" },
  providers: [
    {
      id: "claude-code",
      version: "test",
      auth: { status: scenario === "auth" ? "unknown" : "available", reason: "injected; no prompt sent" },
    },
    { id: "pi", version: "test", auth: { status: "available", reason: "injected; no prompt sent" } },
  ],
}
doctor({ json: true }, Effect.succeed(report)).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      process.exitCode = error instanceof CliFailure ? error.code : 2
    })
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ teardown }),
)
