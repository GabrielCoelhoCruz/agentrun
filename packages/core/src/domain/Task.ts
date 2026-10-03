import { Schema } from "effect"

export const TaskId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "task id must be kebab-case" }),
).pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

export const AgentId = Schema.Literals(["claude-code", "pi"])
export type AgentId = typeof AgentId.Type

export class Task extends Schema.Class<Task>("agentrun/Task")({
  id: TaskId,
  title: Schema.String,
  prompt: Schema.NonEmptyString,
  agent: AgentId,
  model: Schema.optional(Schema.String),
  maxTurns: Schema.optional(Schema.Int),
  maxBudgetUsd: Schema.optional(Schema.Finite),
  stallTimeout: Schema.Duration,
  maxDuration: Schema.Duration,
}) {}
