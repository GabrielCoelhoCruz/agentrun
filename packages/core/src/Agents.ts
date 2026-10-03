import { Context, Layer, Option } from "effect"
import type { Scope, Stream } from "effect"
import * as ClaudeCode from "./agents/ClaudeCode.js"
import type { AgentCapabilities, AgentInput } from "./domain/Agent.js"
import type { AgentEvent } from "./domain/AgentEvent.js"
import type { AgentError } from "./domain/Errors.js"
import type { AgentId } from "./domain/Task.js"

export interface AgentAdapter {
  readonly id: AgentId
  readonly capabilities: AgentCapabilities
  readonly run: (input: AgentInput) => Stream.Stream<AgentEvent, AgentError, Scope.Scope>
}

export class Agents extends Context.Service<Agents, {
  readonly get: (id: AgentId) => Option.Option<AgentAdapter>
}>()("agentrun/Agents") {
  static readonly layer = Layer.succeed(Agents, {
    get: (id) => id === "claude-code" ? Option.some(ClaudeCode.adapter) : Option.none(),
  })
}
