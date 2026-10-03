import { Schema } from "effect"
import { AgentEvent } from "./AgentEvent.js"
import { TaskId } from "./Task.js"
import { TaskStatus } from "./TaskStatus.js"

export const RunEvent = Schema.Union([
  Schema.TaggedStruct("TaskTransition", { taskId: TaskId, status: TaskStatus }),
  Schema.TaggedStruct("TaskAgentEvent", { taskId: TaskId, event: AgentEvent }),
  Schema.TaggedStruct("TaskDeliverable", {
    taskId: TaskId,
    branch: Schema.String,
    committed: Schema.Boolean,
    diff: Schema.String,
  }),
  Schema.TaggedStruct("TaskWarning", { taskId: TaskId, message: Schema.String }),
  Schema.TaggedStruct("RunFinished", { runId: Schema.String }),
])
export type RunEvent = typeof RunEvent.Type
