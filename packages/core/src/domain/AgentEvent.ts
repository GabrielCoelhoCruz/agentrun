import { Schema } from "effect"

export const AgentEvent = Schema.Union([
  Schema.TaggedStruct("Started", { sessionId: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Text", { text: Schema.String }),
  Schema.TaggedStruct("ToolCall", { id: Schema.String, name: Schema.String, input: Schema.Unknown }),
  Schema.TaggedStruct("ToolResult", { id: Schema.String, isError: Schema.Boolean, summary: Schema.String }),
  Schema.TaggedStruct("Usage", {
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    costUsd: Schema.optional(Schema.Finite),
  }),
  Schema.TaggedStruct("Retry", { attempt: Schema.Int, reason: Schema.String }),
  Schema.TaggedStruct("Completed", {
    result: Schema.String,
    costUsd: Schema.optional(Schema.Finite),
    turns: Schema.optional(Schema.Int),
  }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
])
export type AgentEvent = typeof AgentEvent.Type
