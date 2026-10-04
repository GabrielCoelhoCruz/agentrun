import { Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { AgentEvent } from "./AgentEvent.js"
import { AgentId, TaskId } from "./Task.js"

export class TaskFileError extends Schema.TaggedError<TaskFileError>()("TaskFileError", {
  path: Schema.String,
  line: Schema.Int,
  message: Schema.String,
}) {}

export class UnsupportedOption extends Schema.TaggedError<UnsupportedOption>()("UnsupportedOption", {
  taskId: TaskId,
  agent: AgentId,
  option: Schema.Literals(["maxBudgetUsd", "maxTurns", "model"]),
  path: Schema.String,
  line: Schema.Int,
  message: Schema.String,
}) {}

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  command: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {}

export class AgentSpawnError extends Schema.TaggedError<AgentSpawnError>()("AgentSpawnError", {
  agent: AgentId,
  cause: Schema.Defect(),
  retryable: Schema.optional(Schema.Boolean),
}) {}

export const retryableSpawnError = (error: AgentSpawnError): boolean =>
  error.retryable !== false && !(typeof error.cause === "object" && error.cause !== null && "_tag" in error.cause)

export class AgentCrashed extends Schema.TaggedError<AgentCrashed>()("AgentCrashed", {
  agent: AgentId,
  exitCode: Schema.Int,
  lastEvent: Schema.Option(AgentEvent),
}) {}

export class AgentProtocolError extends Schema.TaggedError<AgentProtocolError>()("AgentProtocolError", {
  agent: AgentId,
  line: Schema.String,
  issue: Schema.String,
}) {}

export class AgentTaskFailed extends Schema.TaggedError<AgentTaskFailed>()("AgentTaskFailed", {
  agent: AgentId,
  reason: Schema.String,
}) {}

export class AgentStalled extends Schema.TaggedError<AgentStalled>()("AgentStalled", {
  agent: AgentId,
  idleFor: Schema.Duration,
}) {}

export class AgentTimedOut extends Schema.TaggedError<AgentTimedOut>()("AgentTimedOut", {
  agent: AgentId,
  after: Schema.Duration,
}) {}

export class StateCorrupted extends Schema.TaggedError<StateCorrupted>()("StateCorrupted", {
  path: Schema.String,
  issue: Schema.String,
}) {}

export class SetupError extends Schema.TaggedError<SetupError>()("SetupError", {
  taskId: TaskId,
  command: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {}

export class RunLocked extends Schema.TaggedError<RunLocked>()("RunLocked", {
  path: Schema.String,
  pid: Schema.Int,
}) {}

export class RunNotFound extends Schema.TaggedError<RunNotFound>()("RunNotFound", {
  runId: Schema.String,
}) {}

export type TaskError =
  | GitError
  | SetupError
  | AgentSpawnError
  | AgentCrashed
  | AgentProtocolError
  | AgentTaskFailed
  | AgentStalled
  | AgentTimedOut

export class ReportError extends Schema.TaggedError<ReportError>()("ReportError", {
  path: Schema.String,
  issue: Schema.String,
}) {
  override get message(): string {
    return `${this.path}: ${this.issue}`
  }
}

export type RunnerError = RunLocked | StateCorrupted | GitError | PlatformError | ReportError

export type AgentError = AgentSpawnError | AgentCrashed | AgentProtocolError | SetupError
