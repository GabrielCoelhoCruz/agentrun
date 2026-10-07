import { RunLock } from "@agentrun/core"
import { Effect, Schema } from "effect"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Candidate, FactoryError, failure, HumanAction, Id } from "./Domain.js"
import type { Artifact, HumanDecision, HumanRequest, Projection } from "./Domain.js"
import { gitBytes, inside, io, readBytes, sha256, syncDirectory, writeExclusive } from "./Files.js"
import { stop } from "./Processes.js"
import { executorIdentity, prepareProfile, repository } from "./Profile.js"
import {
  cleanupChecks,
  cleanupExecutor,
  executeAgent,
  executeCheck,
  prepareAgent,
  prepareCheck,
  withGitLock,
} from "./Stages.js"
import { blob, Store } from "./Store.js"

export const WorkflowCommand = Schema.Union([
  Schema.TaggedStruct("Start", { id: Id, profile: Schema.String, goal: Schema.NonEmptyString }),
  Schema.TaggedStruct("Status", { id: Id }),
  Schema.TaggedStruct("Resume", { id: Id }),
  Schema.TaggedStruct("Cancel", { id: Id, expectedVersion: Schema.Int }),
  Schema.TaggedStruct("Decide", {
    id: Id,
    requestId: Id,
    candidate: Candidate.fields.commit,
    evidenceDigest: Schema.String,
    expectedVersion: Schema.Int,
    action: HumanAction,
  }),
  Schema.TaggedStruct("Export", { id: Id }),
  Schema.TaggedStruct("Events", { id: Id, after: Schema.Int }),
])
export type WorkflowCommand = typeof WorkflowCommand.Type
type Action =
  | { readonly kind: "implement" | "correct" | "review" }
  | { readonly kind: "check"; readonly checkId: string }
  | { readonly kind: "reconcile" }
  | {
    readonly kind: "request"
    readonly reason: string
    readonly allowed: readonly ["approve" | "correct" | "reject", ...Array<"approve" | "correct" | "reject">]
  }
  | { readonly kind: "wait" }

const next = (state: Projection): Action => {
  if (state.cancelRequested || state.cancelled || state.exported !== undefined) return { kind: "wait" }
  if (state.fault !== undefined) {
    if (state.request !== undefined) return { kind: "wait" }
    const settled = state.current?.completed || (state.current?.result !== undefined && state.current.stopped)
    return {
      kind: "request",
      reason: state.fault.message,
      allowed: settled && state.candidate !== undefined ? ["correct", "reject"] : ["reject"],
    }
  }
  if (state.manualCorrection) return { kind: "correct" }
  if (state.request !== undefined) return { kind: "wait" }
  if (state.current !== undefined && !state.current.completed) return { kind: "reconcile" }
  if (state.candidate === undefined) return { kind: "implement" }
  const delivered = state.attempts.find((entry) => entry.attempt.id === state.candidate?.attemptId)
  if (state.candidate.outcome === "no-change" && delivered?.attempt.kind === "correct") {
    return {
      kind: "request",
      reason: "Correction made no change. No repair was established.",
      allowed: ["correct", "reject"],
    }
  }
  const missing = state.run.profile.checks.find((check) =>
    !state.evidence.some((evidence) => evidence.checkId === check.id)
  )
  if (missing !== undefined) return { kind: "check", checkId: missing.id }
  const correction = (): Action => {
    const used = state.attempts.filter((entry) => entry.attempt.kind === "correct" && entry.attempt.automatic).length
    return used < (state.run.profile.limits.corrections ?? 2)
      ? { kind: "correct" }
      : {
        kind: "request",
        reason: "Automatic correction limit reached. Inspect the failed checks and review.",
        allowed: ["correct", "reject"],
      }
  }
  if (state.evidence.some((evidence) => evidence.outcome !== "pass")) return correction()
  if (state.review === undefined) return { kind: "review" }
  if (state.review.verdict === "revision-needed") return correction()
  if (state.review.verdict === "human-needed") {
    return {
      kind: "request",
      reason: "Review requires a human decision before further work.",
      allowed: ["correct", "reject"],
    }
  }
  return {
    kind: "request",
    reason: state.candidate.outcome === "no-change"
      ? "No code change was made. Executed checks and review accept the existing candidate. Confirm local export."
      : "Checks and review accept this candidate. Confirm local export.",
    allowed: ["approve", "correct", "reject"],
  }
}

const evidenceDigest = (state: Projection) =>
  sha256(
    JSON.stringify({
      candidate: state.candidate ?? null,
      evidence: state.evidence,
      review: state.review ?? null,
      fault: state.fault ?? null,
    }),
  )

export const statusOf = (state: Projection) => {
  const action = next(state)
  const stage = state.exported !== undefined
    ? "exported"
    : state.cancelled
    ? "cancelled"
    : state.cancelRequested
    ? "cancelling"
    : state.decision?.action === "reject"
    ? "rejected"
    : state.decision?.action === "approve"
    ? "approved"
    : state.fault !== undefined
    ? "blocked"
    : state.request !== undefined && !state.manualCorrection
    ? "human"
    : action.kind === "check"
    ? "checks"
    : action.kind === "reconcile"
    ? state.current?.attempt.kind === "check" ? "checks" : state.current?.attempt.kind ?? "blocked"
    : action.kind
  const request = state.request ?? null
  const decision = state.decision ?? null
  const nextAction = stage === "exported"
    ? "Inspect the local export. Publication remains a separate human action."
    : stage === "approved"
    ? `agentrun-factory export ${state.run.id}`
    : state.cancelled
    ? "Inspect the interrupted attempt. Start a new workflow only after resolving its effects."
    : state.fault?.recoverable
    ? `Inspect the exact attempt, then run agentrun-factory resume ${state.run.id}`
    : request !== null && decision === null
    ? `agentrun-factory decide ${state.run.id} --request ${request.id} --candidate ${request.candidate} --evidence ${request.evidenceDigest} --expected-version ${request.expectedVersion} --action ${
      request.allowedActions[0]
    }`
    : `agentrun-factory resume ${state.run.id}`
  return {
    version: state.version,
    id: state.run.id,
    project: state.run.profile.project,
    stage,
    candidate: state.candidate ?? null,
    blocker: state.fault?.message
      ?? (request !== null && !request.allowedActions.includes("approve") ? request.reason : null),
    request,
    decision,
    evidence: state.evidence,
    review: state.review ?? null,
    nextAction,
    attempts: state.attempts.map(({ attempt, completed, result, process }) => ({
      id: attempt.id,
      kind: attempt.kind,
      inputSha: attempt.inputSha,
      executorRunId: attempt.kind === "check" ? null : attempt.executorRunId,
      checkId: attempt.kind === "check" ? attempt.checkId : null,
      processId: process?.pid ?? null,
      completed,
      outcome: result === undefined ? "not-recorded" : result.exitCode === 0 ? "command-completed" : "command-failed",
    })),
    durationMs: state.durationMs,
    durationComplete: !state.attempts.some((attempt) => attempt.released && attempt.result === undefined),
    costUsd: state.costUsd,
    providerBudget: state.run.profile.limits.providerBudgetUsd === undefined
      ? null
      : {
        limitUsd: state.run.profile.limits.providerBudgetUsd,
        reservedOrReportedUsd: state.reservedUsd,
        availableUsd: Math.max(0, state.run.profile.limits.providerBudgetUsd - state.reservedUsd),
      },
    export: state.exported ?? null,
  }
}

const requestHuman = (
  store: Store,
  state: Projection,
  reason: string,
  allowedActions: HumanRequest["allowedActions"],
) => {
  const request: HumanRequest = {
    id: `request-${state.version + 1}`,
    candidate: state.candidate?.commit ?? state.run.baseSha,
    evidenceDigest: evidenceDigest(state),
    expectedVersion: state.version + 1,
    reason,
    allowedActions,
  }
  return store.append({ _tag: "HumanRequested", request }, [], state.version)
}

const cancelOwned = (store: Store) =>
  Effect.gen(function*() {
    let state = yield* store.read()
    if (state.cancelled) return
    if (!state.cancelRequested) state = yield* store.append({ _tag: "CancelRequested" })
    const current = state.current
    if (current !== undefined && !current.completed) {
      if (current.process !== undefined && !current.stopped) {
        yield* stop(store, current.attempt.id, current.process, "Cancellation requested")
      }
      if (current.attempt.kind !== "check") {
        yield* cleanupExecutor(store, state.run, current.attempt)
      }
    }
    yield* store.append({ _tag: "Cancelled" })
  })

const drive = (store: Store) => {
  const loop = Effect.gen(function*() {
    while (true) {
      const state = yield* store.read()
      if (state.cancelRequested) return yield* failure("cancelled", "Cancellation requested", 130)
      const action = next(state)
      if (action.kind === "wait") return
      if (action.kind === "request") {
        yield* requestHuman(store, state, action.reason, action.allowed)
        return
      }
      if (action.kind === "reconcile") {
        const current = state.current
        if (current === undefined) return yield* failure("state", "Reconciliation has no current attempt")
        if (current.attempt.kind === "check") yield* executeCheck(store, state, current)
        else yield* executeAgent(store, state, current)
      } else if (action.kind === "check") yield* prepareCheck(store, state, action.checkId)
      else yield* prepareAgent(store, state, action.kind)
    }
  })
  const cancellation = Effect.gen(function*() {
    while (true) {
      if ((yield* store.read()).cancelRequested) return yield* failure("cancelled", "Cancellation requested", 130)
      yield* Effect.sleep("100 millis")
    }
  })
  return Effect.raceFirst(loop, cancellation).pipe(
    Effect.catch((error) =>
      Effect.gen(function*() {
        if (error.code === "cancelled") {
          yield* cancelOwned(store)
          return
        }
        let state = yield* store.read()
        state = yield* store.append({
          _tag: "FaultRecorded",
          code: error.code,
          message: error.message,
          recoverable: ["unknown-outcome", "unknown-check-outcome", "repository-locked"].includes(error.code),
        })
        const action = next(state)
        if (action.kind === "request") yield* requestHuman(store, state, action.reason, action.allowed)
      })
    ),
    Effect.onInterrupt(() => cancelOwned(store).pipe(Effect.orDie)),
  )
}

const decide = (store: Store, decision: HumanDecision) =>
  Effect.gen(function*() {
    const state = yield* store.verify()
    if (state.decision !== undefined && JSON.stringify(state.decision) === JSON.stringify(decision)) {
      if (decision.action === "reject") yield* cancelOwned(store)
      return
    }
    const request = state.request
    if (
      request === undefined || state.cancelRequested || state.cancelled || state.exported !== undefined
      || request.id !== decision.requestId || request.candidate !== decision.candidate
      || request.evidenceDigest !== decision.evidenceDigest || request.expectedVersion !== decision.expectedVersion
      || state.version !== decision.expectedVersion || evidenceDigest(state) !== decision.evidenceDigest
    ) {
      return yield* failure(
        "stale-decision",
        "Human decision is stale or does not match the current candidate and evidence",
      )
    }
    if (!request.allowedActions.includes(decision.action)) {
      return yield* failure("decision", "This human request does not allow that action")
    }
    if (
      decision.action === "approve"
      && (state.review?.verdict !== "accepted" || state.evidence.length !== state.run.profile.checks.length
        || state.evidence.some((evidence) => evidence.outcome !== "pass"))
    ) return yield* failure("decision", "Executed acceptance and an accepted review are required before local export")
    const current = state.current
    if (
      decision.action === "correct" && current !== undefined && !current.completed && current.attempt.kind !== "check"
    ) {
      yield* cleanupExecutor(store, state.run, current.attempt)
    }
    yield* store.append({ _tag: "HumanDecided", decision }, [], decision.expectedVersion)
    if (decision.action === "reject") yield* cancelOwned(store)
  })

const exportLocal = (store: Store) =>
  Effect.gen(function*() {
    let state = yield* store.verify()
    if (
      state.cancelRequested || state.cancelled || state.decision?.action !== "approve" || state.candidate === undefined
      || state.request?.candidate !== state.candidate.commit || state.decision.evidenceDigest !== evidenceDigest(state)
    ) return yield* failure("export", "Local export requires approval for the exact current candidate and evidence")
    if (state.exportPrepared === undefined) {
      const candidate = state.candidate
      const source = blob(
        yield* withGitLock(state.run, gitBytes(state.run.repoRoot, ["archive", "--format=tar", candidate.commit])),
      )
      const patch = blob(
        yield* gitBytes(state.run.repoRoot, ["diff", "--binary", `${state.run.baseSha}..${candidate.commit}`]),
      )
      const summary = blob(
        JSON.stringify(
          {
            workflow: state.run.id,
            candidate,
            profileHash: state.run.profileHash,
            evidence: state.evidence,
            review: state.review,
            request: state.request,
            decision: state.decision,
            durationMs: state.durationMs,
            costUsd: state.costUsd,
          },
          null,
          2,
        ),
      )
      const saved = yield* store.allArtifacts()
      const files: [Artifact, ...Array<Artifact>] = [
        { name: "source.tar", digest: source.digest },
        { name: "change.patch", digest: patch.digest },
        { name: "profile.json", digest: state.run.profileArtifact },
        { name: "workflow.json", digest: summary.digest },
        ...saved.map((artifact) => ({ name: `artifacts/${artifact.digest}`, digest: artifact.digest })),
      ]
      const manifest = blob(
        JSON.stringify(
          {
            version: 1,
            workflow: state.run.id,
            candidate,
            profileHash: state.run.profileHash,
            evidenceDigest: state.decision.evidenceDigest,
            files,
          },
          null,
          2,
        ),
      )
      const receipt = { directory: join(store.directory, "exports", candidate.commit), manifestDigest: manifest.digest }
      state = yield* store.append({ _tag: "ExportPrepared", receipt, files }, [source, patch, summary, manifest])
    }
    const prepared = state.exportPrepared
    if (prepared === undefined) return yield* failure("export", "Export preparation is missing")
    const owner = JSON.stringify({ workflow: state.run.id, manifestDigest: prepared.receipt.manifestDigest })
    yield* io("export", () => {
      const directory = prepared.receipt.directory
      if (!existsSync(directory)) {
        mkdirSync(join(store.directory, "exports"), { recursive: true, mode: 0o700 })
        mkdirSync(directory, { mode: 0o700 })
        writeExclusive(join(directory, "owner.json"), owner)
        syncDirectory(join(store.directory, "exports"))
      } else if (
        !existsSync(join(directory, "owner.json"))
        || readBytes(join(directory, "owner.json")).toString("utf8") !== owner
      ) throw failure("export", "Existing export has no matching owner receipt. Preserve and inspect it.")
    })
    for (const file of [...prepared.files, { name: "manifest.json", digest: prepared.receipt.manifestDigest }]) {
      const bytes = yield* store.artifact(file.digest)
      yield* io("export", () => writeExclusive(inside(prepared.receipt.directory, file.name), bytes))
    }
    yield* io("export", () => {
      const top = readdirSync(prepared.receipt.directory).sort()
      const expected = [
        ...new Set(["owner.json", "manifest.json", ...prepared.files.map((file) => file.name.split("/")[0] ?? "")]),
      ].sort()
      if (JSON.stringify(top) !== JSON.stringify(expected)) {
        throw failure("export", "Export directory has unexpected files; preserve and inspect it")
      }
    })
    if (state.exported === undefined) yield* store.append({ _tag: "Exported", receipt: prepared.receipt })
  })

const withCoordinator = <A, E, R>(repoRoot: string, commonDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.gen(function*() {
    yield* (yield* RunLock).acquire(repoRoot).pipe(
      Effect.mapError(() =>
        failure(
          "coordinator-active",
          "A factory coordinator is active for this repository. Read status or cancel the exact workflow.",
        )
      ),
    )
    return yield* effect
  })).pipe(Effect.provide(RunLock.layer({ home: join(commonDir, "agentrun/factory/coordinator") })))

export const handle = (command: WorkflowCommand, cwd = process.cwd()) =>
  Effect.scoped(Effect.gen(function*() {
    yield* Schema.decodeUnknownEffect(WorkflowCommand, { onExcessProperty: "error" })(command).pipe(
      Effect.mapError(() => failure("command", "Invalid workflow command", 2)),
    )
    const repo = yield* repository(cwd)
    const directory = join(repo.commonDir, "agentrun/factory/runs", command.id)
    if (command._tag === "Start") {
      const preparation = yield* prepareProfile(
        repo.repoRoot,
        repo.commonDir,
        command.profile,
        command.goal,
        command.id,
      )
      return yield* withCoordinator(
        repo.repoRoot,
        repo.commonDir,
        Effect.gen(function*() {
          const exists = yield* io("state", () => existsSync(directory))
          const store = yield* Store.open(directory, !exists)
          if (!exists) yield* store.append({ _tag: "WorkflowStarted", run: preparation.run }, preparation.blobs)
          const state = yield* store.verify()
          if (
            state.run.executor.digest !== preparation.run.executor.digest
            || state.run.executor.bin !== preparation.run.executor.bin
          ) {
            return yield* failure("executor", "Executor path or runtime differs from this workflow's pinned executor")
          }
          if (
            state.run.profileHash !== preparation.run.profileHash || state.run.goal !== command.goal
            || state.run.baseSha !== preparation.run.baseSha || state.run.repoRoot !== repo.repoRoot
          ) return yield* failure("identity", "Workflow ID already has different immutable preparation", 2)
          yield* drive(store)
          yield* cleanupChecks(yield* store.read())
          return { status: statusOf(yield* store.verify()) }
        }),
      )
    }
    if (!(yield* io("state", () => existsSync(directory)))) {
      return yield* failure("state", "Workflow does not exist. Supply its explicit ID.", 2)
    }
    const store = yield* Store.open(directory)
    const state = yield* store.verify()
    if (
      state.run.id !== command.id || state.run.repoRoot !== repo.repoRoot || state.run.commonDir !== repo.commonDir
    ) {
      return yield* failure("identity", "Workflow belongs to a different project checkout")
    }
    if (command._tag === "Events") {
      return { events: (yield* store.events()).filter((event) => event.seq > command.after) }
    }
    if (command._tag === "Status") return { status: statusOf(state) }
    if (command._tag === "Cancel") {
      if (state.cancelled) return { status: statusOf(state) }
      if (!state.cancelRequested) yield* store.append({ _tag: "CancelRequested" }, [], command.expectedVersion)
      yield* withCoordinator(repo.repoRoot, repo.commonDir, cancelOwned(store)).pipe(
        Effect.catchIf(
          (error) => error instanceof FactoryError && error.code === "coordinator-active",
          () => Effect.void,
        ),
      )
      return { status: statusOf(yield* store.read()) }
    }
    return yield* withCoordinator(
      repo.repoRoot,
      repo.commonDir,
      Effect.gen(function*() {
        const executor = yield* executorIdentity()
        if (executor.digest !== state.run.executor.digest || executor.bin !== state.run.executor.bin) {
          return yield* failure("executor", "Executor path or runtime differs from this workflow's pinned executor")
        }
        if (command._tag === "Decide") {
          yield* decide(store, {
            requestId: command.requestId,
            candidate: command.candidate,
            evidenceDigest: command.evidenceDigest,
            expectedVersion: command.expectedVersion,
            action: command.action,
          })
        } else if (command._tag === "Export") {
          yield* exportLocal(store)
        } else {
          if (state.cancelled) {
            return {
              status: {
                ...statusOf(state),
                blocker: "Cancelled or interrupted attempt requires inspection before new work",
              },
            }
          }
          if (state.fault !== undefined && !state.cancelRequested) {
            yield* store.append({ _tag: "RecoveryStarted" })
          }
          yield* drive(store)
          yield* cleanupChecks(yield* store.read())
        }
        return { status: statusOf(yield* store.verify()) }
      }),
    )
  }))
