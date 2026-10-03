#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { main, teardown } from "./index.js"
import { workerAgents } from "./WorkerAgents.js"
main.pipe(
  Effect.provide(Layer.mergeAll(workerAgents(new URL("./worker.mjs", import.meta.url)), NodeServices.layer)),
  NodeRuntime.runMain({ disableErrorReporting: true, teardown }),
)
