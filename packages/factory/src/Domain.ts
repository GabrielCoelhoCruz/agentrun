import { AgentId, TaskId } from "@agentrun/core"
import { Schema } from "effect"

export class FactoryError extends Schema.TaggedError<FactoryError>()("FactoryError", {
  code: Schema.String,
  message: Schema.String,
  exitCode: Schema.Int,
}) {}
export const failure = (code: string, message: string, exitCode = 1) => new FactoryError({ code, message, exitCode })
export const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,95}$/))
export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Commit = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Money = Schema.Finite.check(Schema.isGreaterThan(0))
export const RelativePath = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\\r\n]).+$/),
  Schema.makeFilter((value) => !value.includes("\0")),
)
const EnvName = Schema.String.check(Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/))
const Role = Schema.Struct({
  agent: AgentId,
  instructions: RelativePath,
  model: Schema.optional(Schema.NonEmptyString),
  maxTurns: Schema.optional(Positive),
  maxBudgetUsd: Schema.optional(Money),
})
export const Check = Schema.Struct({
  id: Id,
  argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  cwd: RelativePath,
  files: Schema.NonEmptyArray(RelativePath),
  requiredEnv: Schema.Array(EnvName),
  timeoutMs: Positive,
})
export const ProjectProfile = Schema.Struct({
  version: Schema.Literal(1),
  project: Id,
  base: Schema.NonEmptyString,
  roles: Schema.Struct({ implement: Role, review: Role }),
  checks: Schema.NonEmptyArray(Check),
  acceptance: Schema.NonEmptyArray(Schema.Struct({ id: Id, description: Schema.NonEmptyString, check: Id })),
  limits: Schema.Struct({
    corrections: Schema.optional(NonNegative),
    durationMs: Positive,
    providerBudgetUsd: Schema.optional(Money),
  }),
})
export type ProjectProfile = typeof ProjectProfile.Type
export type Check = typeof Check.Type
export const Artifact = Schema.Struct({ name: RelativePath, digest: Digest })
export type Artifact = typeof Artifact.Type
export const CommandSpec = Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  cwd: Schema.NonEmptyString,
})
export type CommandSpec = typeof CommandSpec.Type
export const Environment = Schema.Struct({
  platform: Schema.String,
  architecture: Schema.String,
  node: Schema.String,
  requiredEnv: Schema.Array(EnvName),
  executable: Schema.String,
  executableHash: Digest,
})
export const WorkflowRun = Schema.Struct({
  id: Id,
  repoRoot: Schema.NonEmptyString,
  commonDir: Schema.NonEmptyString,
  baseSha: Commit,
  profile: ProjectProfile,
  profileHash: Digest,
  profileArtifact: Digest,
  goal: Schema.NonEmptyString,
  startedAt: NonNegative,
  inputs: Schema.Array(Artifact),
  roleHashes: Schema.Struct({ implement: Digest, review: Digest }),
  checkHashes: Schema.Record(Id, Digest),
  executables: Schema.Record(Schema.String, Environment),
  executor: Schema.Struct({ bin: Schema.NonEmptyString, digest: Digest }),
})
export type WorkflowRun = typeof WorkflowRun.Type
const Preparation = {
  id: Id,
  inputSha: Commit,
  preparedAt: NonNegative,
  preparationHash: Digest,
  command: CommandSpec,
}
export const StageAttempt = Schema.Union([
  Schema.Struct({
    ...Preparation,
    kind: Schema.Literals(["implement", "correct", "review"]),
    executorRunId: Id,
    taskId: TaskId,
    taskArtifact: Digest,
    roleHash: Digest,
    budgetUsd: Schema.NullOr(Money),
    automatic: Schema.Boolean,
  }),
  Schema.Struct({
    ...Preparation,
    kind: Schema.Literal("check"),
    checkId: Id,
    workspaceRunId: Id,
    workspace: Schema.NonEmptyString,
    branch: Schema.NonEmptyString,
    checkHash: Digest,
  }),
])
export type StageAttempt = typeof StageAttempt.Type
export type AgentAttempt = Extract<StageAttempt, { kind: "implement" | "correct" | "review" }>
export type CheckAttempt = Extract<StageAttempt, { kind: "check" }>
export const OwnedProcess = Schema.Struct({
  pid: Positive,
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  generation: Positive,
  directory: Schema.NonEmptyString,
  commandHash: Digest,
  command: CommandSpec,
})
export type OwnedProcess = typeof OwnedProcess.Type
export const ProcessResult = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: Id,
  token: Schema.String,
  commandHash: Digest,
  pid: Positive,
  startedAt: NonNegative,
  durationMs: NonNegative,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
})
export type ProcessResult = typeof ProcessResult.Type
export const Candidate = Schema.Struct({
  commit: Commit,
  baseSha: Commit,
  inputSha: Commit,
  project: Id,
  profileHash: Digest,
  attemptId: Id,
  reportDigest: Digest,
  patchDigest: Digest,
  outcome: Schema.Literals(["delivered", "no-change"]),
})
export type Candidate = typeof Candidate.Type
export const CheckResult = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: Id,
  candidate: Commit,
  checkId: Id,
  criteria: Schema.Array(Schema.Struct({
    id: Id,
    outcome: Schema.Literals(["pass", "fail", "not-run"]),
    artifacts: Schema.NonEmptyArray(RelativePath),
  })),
})
export const Evidence = Schema.Struct({
  attemptId: Id,
  candidate: Commit,
  project: Id,
  profileHash: Digest,
  checkId: Id,
  producer: Schema.Literal("project-command"),
  command: CommandSpec,
  environment: Environment,
  outcome: Schema.Literals(["pass", "fail", "not-run"]),
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: NonNegative,
  criteria: Schema.Array(Schema.Struct({ id: Id, outcome: Schema.Literals(["pass", "fail", "not-run"]) })),
  artifacts: Schema.Array(Artifact).check(Schema.isMinLength(1)),
})
export type Evidence = typeof Evidence.Type
export const Review = Schema.Struct({
  version: Schema.Literal(1),
  candidate: Commit,
  profileHash: Digest,
  verdict: Schema.Literals(["accepted", "revision-needed", "human-needed"]),
  findings: Schema.Array(Schema.Struct({
    file: RelativePath,
    line: Positive,
    severity: Schema.Literals(["low", "medium", "high"]),
    message: Schema.NonEmptyString,
  })),
})
export type Review = typeof Review.Type
export const HumanAction = Schema.Literals(["approve", "correct", "reject"])
export const HumanRequest = Schema.Struct({
  id: Id,
  candidate: Commit,
  evidenceDigest: Digest,
  expectedVersion: Positive,
  allowedActions: Schema.NonEmptyArray(HumanAction),
  reason: Schema.NonEmptyString,
})
export type HumanRequest = typeof HumanRequest.Type
export const HumanDecision = Schema.Struct({
  requestId: Id,
  candidate: Commit,
  evidenceDigest: Digest,
  expectedVersion: Positive,
  action: HumanAction,
})
export type HumanDecision = typeof HumanDecision.Type
export const ExportReceipt = Schema.Struct({ directory: Schema.NonEmptyString, manifestDigest: Digest })
export type ExportReceipt = typeof ExportReceipt.Type
export const Fact = Schema.Union([
  Schema.TaggedStruct("WorkflowStarted", { run: WorkflowRun }),
  Schema.TaggedStruct("AttemptPrepared", { attempt: StageAttempt }),
  Schema.TaggedStruct("ProcessRegistered", { attemptId: Id, process: OwnedProcess }),
  Schema.TaggedStruct("DispatchReleased", {
    attemptId: Id,
    generation: Positive,
    kind: Schema.Literals(["implement", "correct", "review", "check"]),
  }),
  Schema.TaggedStruct("ProcessCompleted", {
    attemptId: Id,
    generation: Positive,
    result: ProcessResult,
    artifacts: Schema.Array(Artifact),
  }),
  Schema.TaggedStruct("ProcessStopped", { attemptId: Id, generation: Positive, reason: Schema.String }),
  Schema.TaggedStruct("OutputCaptured", { attemptId: Id, artifacts: Schema.Array(Artifact) }),
  Schema.TaggedStruct("AgentRecorded", {
    attemptId: Id,
    candidate: Candidate,
    costUsd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.TaggedStruct("CheckRecorded", { attemptId: Id, evidence: Evidence }),
  Schema.TaggedStruct("ReviewRecorded", {
    attemptId: Id,
    review: Review,
    reportDigest: Digest,
    costUsd: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  Schema.TaggedStruct("FaultRecorded", {
    code: Schema.String,
    message: Schema.String,
    recoverable: Schema.Boolean,
    artifacts: Schema.optional(Schema.Array(Artifact)),
  }),
  Schema.TaggedStruct("RecoveryStarted", {}),
  Schema.TaggedStruct("HumanRequested", { request: HumanRequest }),
  Schema.TaggedStruct("HumanDecided", { decision: HumanDecision }),
  Schema.TaggedStruct("CancelRequested", {}),
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("ExportPrepared", { receipt: ExportReceipt, files: Schema.NonEmptyArray(Artifact) }),
  Schema.TaggedStruct("Exported", { receipt: ExportReceipt }),
])
export type Fact = typeof Fact.Type
export interface Event {
  readonly seq: number
  readonly at: number
  readonly fact: Fact
  readonly digest: string
}
export interface AttemptState {
  readonly attempt: StageAttempt
  process?: OwnedProcess
  released: boolean
  stopped: boolean
  result?: ProcessResult
  completed: boolean
  costUsd?: number | null
}
export interface Projection {
  readonly run: WorkflowRun
  version: number
  readonly attempts: Array<AttemptState>
  current?: AttemptState
  candidate?: Candidate
  evidence: Array<Evidence>
  review?: Review
  request?: HumanRequest
  decision?: HumanDecision
  fault?: { readonly code: string; readonly message: string; readonly recoverable: boolean }
  cancelRequested: boolean
  cancelled: boolean
  manualCorrection: boolean
  exportPrepared?: { readonly receipt: ExportReceipt; readonly files: ReadonlyArray<Artifact> }
  exported?: ExportReceipt
  durationMs: number
  costUsd: number | null
  reservedUsd: number
}

export const project = (events: ReadonlyArray<Event>): Projection => {
  const first = events[0]
  if (first?.fact._tag !== "WorkflowStarted" || first.seq !== 1) {
    throw failure("state", "Workflow has no valid initial fact")
  }
  const state: Projection = {
    run: first.fact.run,
    version: 1,
    attempts: [],
    evidence: [],
    cancelRequested: false,
    cancelled: false,
    manualCorrection: false,
    durationMs: 0,
    costUsd: 0,
    reservedUsd: 0,
  }
  const requireAttempt = (id: string) => {
    const current = state.current
    if (current === undefined || current.completed || current.attempt.id !== id) {
      throw failure("state", "Result belongs to an old or unknown attempt")
    }
    return current
  }
  for (const event of events.slice(1)) {
    if (event.seq !== state.version + 1) throw failure("state", "Workflow event sequence has a gap")
    state.version = event.seq
    const fact = event.fact
    switch (fact._tag) {
      case "WorkflowStarted":
        throw failure("state", "Duplicate workflow preparation")
      case "AttemptPrepared": {
        if (state.current !== undefined && !state.current.completed) {
          throw failure("state", "An attempt is still unresolved")
        }
        if (state.attempts.some((entry) => entry.attempt.id === fact.attempt.id)) {
          throw failure("state", "Duplicate attempt identity")
        }
        if (fact.attempt.inputSha !== (state.candidate?.commit ?? state.run.baseSha)) {
          throw failure("state", "Attempt candidate differs from current delivery")
        }
        if (
          fact.attempt.kind === "check"
            ? fact.attempt.checkHash !== state.run.checkHashes[fact.attempt.checkId]
            : fact.attempt.roleHash
              !== (fact.attempt.kind === "review" ? state.run.roleHashes.review : state.run.roleHashes.implement)
        ) throw failure("state", "Attempt producer differs from its pinned definition")
        if (state.cancelRequested || state.cancelled || state.exported !== undefined) {
          throw failure("state", "Workflow cannot dispatch in this state")
        }
        const current: AttemptState = { attempt: fact.attempt, released: false, stopped: false, completed: false }
        state.attempts.push(current)
        state.current = current
        if (fact.attempt.kind !== "check") state.reservedUsd += fact.attempt.budgetUsd ?? 0
        if (fact.attempt.kind === "correct") {
          state.manualCorrection = false
          delete state.request
          delete state.decision
        }
        break
      }
      case "ProcessRegistered": {
        const current = requireAttempt(fact.attemptId)
        if (current.process !== undefined && !current.stopped) {
          throw failure("state", "An owned process is still unresolved")
        }
        if (fact.process.generation !== (current.process?.generation ?? 0) + 1) {
          throw failure("state", "Process generation is stale")
        }
        current.process = fact.process
        current.released = false
        current.stopped = false
        delete current.result
        break
      }
      case "DispatchReleased": {
        const current = requireAttempt(fact.attemptId)
        if (
          current.process?.generation !== fact.generation || current.released || current.stopped
          || state.cancelRequested
        ) throw failure("state", "Dispatch does not own the current process")
        current.released = true
        break
      }
      case "ProcessCompleted": {
        const current = requireAttempt(fact.attemptId)
        if (current.process?.generation !== fact.generation || !current.released || current.result !== undefined) {
          throw failure("state", "Process result is stale or was not dispatched")
        }
        if (
          fact.result.attemptId !== fact.attemptId || fact.result.token !== current.process.token
          || fact.result.pid !== current.process.pid || fact.result.commandHash !== current.process.commandHash
        ) throw failure("state", "Process receipt identity differs")
        current.result = fact.result
        state.durationMs += fact.result.durationMs
        break
      }
      case "ProcessStopped": {
        const current = requireAttempt(fact.attemptId)
        if (current.process?.generation !== fact.generation) {
          throw failure("state", "Stop result belongs to an old process")
        }
        current.stopped = true
        break
      }
      case "OutputCaptured": {
        const current = requireAttempt(fact.attemptId)
        if (current.result === undefined || !current.stopped) {
          throw failure("state", "Output has no completed owned producer")
        }
        break
      }
      case "AgentRecorded": {
        const current = requireAttempt(fact.attemptId)
        if (
          current.attempt.kind === "check" || current.attempt.kind === "review" || current.result === undefined
          || !current.stopped
        ) throw failure("state", "Agent delivery has no completed owned process")
        if (
          fact.candidate.baseSha !== state.run.baseSha || fact.candidate.inputSha !== current.attempt.inputSha
          || fact.candidate.attemptId !== fact.attemptId || fact.candidate.profileHash !== state.run.profileHash
          || fact.candidate.project !== state.run.profile.project
        ) throw failure("state", "Candidate identity differs from preparation")
        current.completed = true
        state.candidate = fact.candidate
        state.evidence = []
        delete state.review
        delete state.request
        delete state.decision
        current.costUsd = fact.costUsd
        if (fact.costUsd !== null) state.reservedUsd += fact.costUsd - (current.attempt.budgetUsd ?? 0)
        break
      }
      case "CheckRecorded": {
        const current = requireAttempt(fact.attemptId)
        if (
          current.attempt.kind !== "check" || current.result === undefined || !current.stopped
          || fact.evidence.candidate !== state.candidate?.commit || fact.evidence.attemptId !== fact.attemptId
          || fact.evidence.checkId !== current.attempt.checkId || fact.evidence.profileHash !== state.run.profileHash
          || fact.evidence.project !== state.run.profile.project
        ) throw failure("state", "Check evidence does not match the executed candidate")
        const expected = state.run.profile.acceptance.filter((criterion) => criterion.check === fact.evidence.checkId)
          .map((criterion) => criterion.id).sort()
        if (
          JSON.stringify(fact.evidence.criteria.map((criterion) => criterion.id).sort()) !== JSON.stringify(expected)
          || JSON.stringify(fact.evidence.command) !== JSON.stringify(current.attempt.command)
          || fact.evidence.exitCode !== current.result.exitCode
          || fact.evidence.durationMs !== current.result.durationMs
        ) throw failure("state", "Check evidence differs from its executed criteria or command")
        if (
          fact.evidence.outcome === "pass"
          && (current.result.exitCode !== 0 || current.result.signal !== null
            || fact.evidence.criteria.some((criterion) => criterion.outcome !== "pass"))
        ) throw failure("state", "Check pass has no successful executed criteria")
        if (state.evidence.some((evidence) => evidence.checkId === fact.evidence.checkId)) {
          throw failure("state", "Check evidence was already accepted for this candidate")
        }
        current.completed = true
        state.evidence.push(fact.evidence)
        break
      }
      case "ReviewRecorded": {
        const current = requireAttempt(fact.attemptId)
        if (
          current.attempt.kind !== "review" || current.result === undefined || !current.stopped
          || fact.review.candidate !== state.candidate?.commit || fact.review.profileHash !== state.run.profileHash
        ) throw failure("state", "Review does not match the executed candidate")
        current.completed = true
        state.review = fact.review
        current.costUsd = fact.costUsd
        if (fact.costUsd !== null) state.reservedUsd += fact.costUsd - (current.attempt.budgetUsd ?? 0)
        break
      }
      case "FaultRecorded":
        state.fault = fact
        break
      case "RecoveryStarted":
        delete state.fault
        delete state.request
        delete state.decision
        break
      case "HumanRequested":
        if (
          fact.request.candidate !== (state.candidate?.commit ?? state.run.baseSha)
          || fact.request.expectedVersion !== event.seq
        ) throw failure("state", "Human request identity differs")
        if (
          fact.request.allowedActions.includes("approve")
          && (state.fault !== undefined || state.review?.verdict !== "accepted"
            || state.evidence.length !== state.run.profile.checks.length || state.evidence.some((evidence) =>
              evidence.outcome !== "pass"
            ))
        ) throw failure("state", "Approval request has incomplete acceptance")
        state.request = fact.request
        delete state.decision
        break
      case "HumanDecided": {
        const request = state.request
        if (
          request === undefined || request.id !== fact.decision.requestId
          || request.candidate !== fact.decision.candidate || request.evidenceDigest !== fact.decision.evidenceDigest
          || request.expectedVersion !== fact.decision.expectedVersion
          || !request.allowedActions.includes(fact.decision.action) || state.decision !== undefined
        ) throw failure("state", "Human decision is stale or conflicts with its request")
        state.decision = fact.decision
        state.manualCorrection = fact.decision.action === "correct"
        if (state.manualCorrection) {
          if (state.current !== undefined && !state.current.completed) {
            if (state.current.result === undefined || !state.current.stopped) {
              throw failure("state", "Unresolved effects cannot be replaced by a correction")
            }
            state.current.completed = true
          }
          delete state.fault
        }
        break
      }
      case "CancelRequested":
        state.cancelRequested = true
        break
      case "Cancelled":
        state.cancelled = true
        break
      case "ExportPrepared":
        if (state.decision?.action !== "approve" || state.candidate === undefined) {
          throw failure("state", "Local export has no current approval")
        }
        state.exportPrepared = fact
        break
      case "Exported":
        if (
          state.exportPrepared?.receipt.manifestDigest !== fact.receipt.manifestDigest
          || state.exportPrepared.receipt.directory !== fact.receipt.directory
        ) throw failure("state", "Export differs from its preparation")
        state.exported = fact.receipt
        break
    }
  }
  const dispatched = new Set(
    events.flatMap((event) =>
      event.fact._tag === "DispatchReleased" && event.fact.kind !== "check" ? [event.fact.attemptId] : []
    ),
  )
  const charged = state.attempts.filter((entry) => dispatched.has(entry.attempt.id))
  state.costUsd = charged.some((entry) => entry.costUsd === undefined || entry.costUsd === null)
    ? null
    : charged.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
  return state
}
