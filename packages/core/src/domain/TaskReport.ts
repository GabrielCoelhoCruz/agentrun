import { Schema } from "effect"
import { AgentEvent } from "./AgentEvent.js"

export const TaskReportFields = {
  phase: Schema.Literals(["completed", "delivered", "unfinished", "failed"]),
  durationMs: Schema.optional(Schema.Int),
  costUsd: Schema.optional(Schema.Finite),
  result: Schema.optional(Schema.String),
  deliveryCommit: Schema.optional(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))),
  patchSha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  diffStat: Schema.optional(Schema.Struct({ files: Schema.Int, additions: Schema.Int, deletions: Schema.Int })),
}
export const TaskReport = Schema.Struct({
  ...TaskReportFields,
  pendingEvent: Schema.optional(AgentEvent),
  attempt: Schema.optional(Schema.Int),
  eventOffset: Schema.optional(Schema.Int),
  failureReason: Schema.optional(Schema.String),
  toolsStarted: Schema.optional(Schema.Boolean),
  setupCompleted: Schema.optional(Schema.Boolean),
  adapterAttempt: Schema.optional(Schema.Int),
  elapsedBeforeMs: Schema.optional(Schema.Int),
})
export type TaskReport = typeof TaskReport.Type
