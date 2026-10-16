#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Exit } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { FactoryError, HumanAction, Id } from "./Domain.js"
import { handle } from "./Workflow.js"
import type { WorkflowCommand } from "./Workflow.js"

const json = Flag.Boolean("json").pipe(Flag.withDefault(false))
const id = Argument.String("workflow-id").pipe(Argument.withSchema(Id))
const execute = (command: WorkflowCommand, json: boolean) =>
  Effect.gen(function*() {
    const result = yield* handle(command)
    if ("events" in result) process.stdout.write(`${JSON.stringify(result.events)}\n`)
    else {
      const status = result.status
      if (json) process.stdout.write(`${JSON.stringify(status)}\n`)
      else {process.stdout.write(
          `Workflow ${status.id}: ${status.stage}\nCandidate: ${status.candidate?.commit ?? "not delivered"}\n${
            status.blocker === null ? "" : `Blocker: ${status.blocker}\n`
          }Duration: ${status.durationMs}ms\nCost: ${
            status.costUsd === null ? "unknown" : `$${status.costUsd}`
          }\nNext: ${status.nextAction}\n`,
        )}
      if (!["Status", "Cancel", "Decide"].includes(command._tag)) {
        process.exitCode = status.stage === "cancelled"
          ? command._tag === "Resume" ? 1 : 130
          : status.stage === "blocked" || status.stage === "rejected"
              || (status.stage === "human" && !status.request?.allowedActions.includes("approve"))
          ? 1
          : 0
      }
    }
  })
const command = Command.make("agentrun-factory").pipe(Command.withSubcommands([
  Command.make("start", {
    id: Flag.String("id").pipe(Flag.withSchema(Id)),
    profile: Flag.String("profile"),
    goal: Flag.String("goal"),
    json,
  }, ({ id, profile, goal, json }) => execute({ _tag: "Start", id, profile, goal }, json)),
  Command.make("status", { id, json }, ({ id, json }) => execute({ _tag: "Status", id }, json)),
  Command.make("resume", { id, json }, ({ id, json }) => execute({ _tag: "Resume", id }, json)),
  Command.make(
    "cancel",
    { id, json, version: Flag.Int("expected-version") },
    ({ id, version, json }) => execute({ _tag: "Cancel", id, expectedVersion: version }, json),
  ),
  Command.make("decide", {
    id,
    json,
    requestId: Flag.String("request"),
    candidate: Flag.String("candidate"),
    evidenceDigest: Flag.String("evidence"),
    expectedVersion: Flag.Int("expected-version"),
    action: Flag.Literals("action", HumanAction.literals),
  }, ({ json, ...decision }) => execute({ _tag: "Decide", ...decision }, json)),
  Command.make("export", { id, json }, ({ id, json }) => execute({ _tag: "Export", id }, json)),
  Command.make(
    "events",
    { id, json, after: Flag.Int("after").pipe(Flag.withDefault(0)) },
    ({ id, json, after }) => execute({ _tag: "Events", id, after }, json),
  ),
]))
const main = Command.run(command, { version: "0.1.0" }).pipe(
  Effect.provideService(Console.Console, console),
  Effect.catch((error) =>
    Effect.sync(() => {
      process.exitCode = error instanceof FactoryError ? error.exitCode : 2
      process.stderr.write(`${error instanceof FactoryError ? `${error.code}: ${error.message}` : String(error)}\n`)
    })
  ),
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.sync(() => {
      process.exitCode = 1
      process.stderr.write(`${Cause.pretty(cause)}\n`)
    })
  ),
  Effect.provide(NodeServices.layer),
)
NodeRuntime.runMain(main, {
  disableErrorReporting: true,
  teardown: (exit, done) =>
    done(Exit.hasInterrupts(exit) ? 130 : Exit.isFailure(exit) ? 1 : Number(process.exitCode ?? 0)),
})
