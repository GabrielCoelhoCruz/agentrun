import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { main, teardown } from "../../src/index.js"
import { workerAgents } from "../../src/WorkerAgents.js"
main.pipe(
  Effect.provide(Layer.mergeAll(workerAgents(new URL("./fake-worker.mjs", import.meta.url)), NodeServices.layer)),
  NodeRuntime.runMain({ disableErrorReporting: true, teardown }),
)
