import { Schema } from "effect"
import { RunState } from "./RunState.js"
import { TaskId } from "./Task.js"
import { TaskReportFields } from "./TaskReport.js"

export class RunReport extends Schema.Class<RunReport>("agentrun/RunReport")({
  ...RunState.fields,
  taskReports: Schema.optional(Schema.Record(TaskId, Schema.Struct(TaskReportFields))),
  worktrees: Schema.Record(TaskId, Schema.Struct({ path: Schema.String, branch: Schema.String })),
}) {}
