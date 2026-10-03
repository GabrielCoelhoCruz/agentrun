import { Schema } from "effect"

export const TaskStatus = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("running", { attempt: Schema.Int, startedAt: Schema.DateTimeUtc }),
  Schema.TaggedStruct("succeeded", { durationMs: Schema.Int, costUsd: Schema.optional(Schema.Finite) }),
  Schema.TaggedStruct("failed", { attempt: Schema.Int, reason: Schema.String }),
  Schema.TaggedStruct("interrupted", { attempt: Schema.Int }),
])
export type TaskStatus = typeof TaskStatus.Type
