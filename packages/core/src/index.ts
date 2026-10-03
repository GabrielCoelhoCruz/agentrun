import packageJson from "../package.json" with { type: "json" }

export const version = packageJson.version

export { type AgentAdapter, Agents } from "./Agents.js"
export * as ClaudeCode from "./agents/ClaudeCode.js"
export type { AgentCapabilities, AgentInput } from "./domain/Agent.js"
export { AgentEvent } from "./domain/AgentEvent.js"
export * from "./domain/Errors.js"
export { RunState } from "./domain/RunState.js"
export { AgentId, Task, TaskId } from "./domain/Task.js"
export { TaskStatus } from "./domain/TaskStatus.js"
export { TaskFile } from "./TaskFile.js"
