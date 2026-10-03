import type { Option } from "effect"

export interface AgentInput {
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
