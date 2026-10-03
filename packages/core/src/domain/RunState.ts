import { Schema } from "effect"
import { Task, TaskId } from "./Task.js"
import { TaskStatus } from "./TaskStatus.js"

export class RunState extends Schema.Class<RunState>("agentrun/RunState")({
  version: Schema.Literal(1),
  runId: Schema.String,
  repoRoot: Schema.String,
  base: Schema.String,
  baseSha: Schema.String,
  concurrency: Schema.Int,
  setup: Schema.optional(Schema.String),
  tasks: Schema.Array(Task),
  status: Schema.Record(TaskId, TaskStatus),
  worktrees: Schema.Record(
    TaskId,
    Schema.Struct({
      path: Schema.String,
      branch: Schema.String,
      pgid: Schema.optional(Schema.Int),
    }),
  ),
}) {}
