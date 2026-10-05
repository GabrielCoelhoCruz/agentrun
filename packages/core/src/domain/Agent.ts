import type { Effect, Option } from "effect"
import type { AgentError } from "./Errors.js"
import type { TaskId } from "./Task.js"

export interface AgentInput {
  readonly taskId?: TaskId
  readonly loadProjectSettings?: boolean
  readonly setup?: string
  readonly setupCompleted?: () => Effect.Effect<void, AgentError>
  readonly workerProcessGroup?: boolean
  readonly registerProcess?: (pgid: number, token: string) => Effect.Effect<void, AgentError>
  readonly prompt: string
  readonly cwd: string
  readonly model: Option.Option<string>
  readonly maxTurns: Option.Option<number>
  readonly maxBudgetUsd: Option.Option<number>
}

export interface AgentCapabilities {
  readonly maxTurns: boolean
  readonly maxBudgetUsd: boolean
  readonly model: boolean
  readonly costReporting: boolean
}
