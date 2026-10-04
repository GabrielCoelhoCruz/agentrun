import { ClaudeCode, Pi } from "@agentrun/core"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { serveWorker } from "./WorkerAgents.js"
NodeRuntime.runMain(
  serveWorker((input, agent) => (agent === "pi" ? Pi.adapter : ClaudeCode.adapter).run(input)).pipe(
    Effect.provide(NodeServices.layer),
  ),
  {
    disableErrorReporting: true,
  },
)
