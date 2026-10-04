import { ByteSize, Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { AgentEvent } from "./domain/AgentEvent.js"
import { ReportError } from "./domain/Errors.js"
import { RunReport } from "./domain/RunReport.js"
import { RunState } from "./domain/RunState.js"
import type { TaskId } from "./domain/Task.js"

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1").replace(/\r?\n/g, "<br>")

export const markdown = (report: RunReport): string => {
  const rows = report.tasks.map((task) => {
    const data = report.taskReports?.[task.id]
    const status = report.status[task.id]
    const duration = data?.durationMs ?? (status?._tag === "succeeded" ? status.durationMs : undefined)
    const cost = data?.costUsd ?? (status?._tag === "succeeded" ? status.costUsd : undefined)
    return `| ${escape(task.id)} | ${task.agent} | ${status?._tag ?? "pending"} | ${
      duration === undefined ? "n/a" : `${(duration / 1000).toFixed(2)}s`
    } | ${cost === undefined ? "n/a" : `$${cost.toFixed(6)}`} | ${escape(report.worktrees[task.id]?.branch ?? "n/a")} |`
  })
  const sections = report.tasks.map((task) => {
    const data = report.taskReports?.[task.id]
    const status = report.status[task.id]
    const stat = data?.diffStat
    const diff = stat === undefined
      ? ""
      : `Diff: tasks/${task.id}/diff.patch (${stat.files} files, +${stat.additions} -${stat.deletions})\n\n`
    const result = status?._tag === "failed"
      ? `Reason: ${escape(status.reason)}`
      : `Result: ${data?.result === undefined ? "unavailable (not recorded)" : escape(data.result)}`
    return `## ${escape(task.id)}\n\n${diff}${result}`
  })
  return `# agentrun. Run ${
    escape(report.runId)
  }\n\n| Task | Agent | Status | Duration | Cost | Branch |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n\n${
    sections.join("\n\n")
  }\n`
}

export class Report extends Context.Service<Report, {
  readonly lastEvent: (
    state: RunState,
    taskId: TaskId,
    offset?: number,
  ) => Effect.Effect<Option.Option<AgentEvent>, ReportError>
  readonly append: (state: RunState, taskId: TaskId, event: AgentEvent) => Effect.Effect<void, ReportError>
  readonly eventSize: (state: RunState, taskId: TaskId) => Effect.Effect<number, ReportError>
  readonly readPatch: (state: RunState, taskId: TaskId) => Effect.Effect<Option.Option<Uint8Array>, ReportError>
  readonly patch: (state: RunState, taskId: TaskId, diff: Uint8Array) => Effect.Effect<void, ReportError>
  readonly save: (state: RunState) => Effect.Effect<void, ReportError>
  readonly load: (repoRoot: string, runId: string) => Effect.Effect<RunReport, ReportError>
}>()("agentrun/Report") {
  static readonly layer = Layer.effect(
    Report,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const codec = Schema.toCodecJson(RunReport)
      const events = Schema.toCodecJson(AgentEvent)
      const root = (repoRoot: string, runId: string) => path.join(repoRoot, ".agentrun", "runs", runId)
      const error = (target: string, cause: { readonly message: string }) =>
        new ReportError({ path: target, issue: cause.message })
      const atomic = Effect.fn("Report.atomic")(function*(target: string, content: string) {
        yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 })
        yield* fs.writeFileString(`${target}.tmp`, content, { mode: 0o600 })
        yield* fs.rename(`${target}.tmp`, target)
      }, (effect, target) => effect.pipe(Effect.mapError((cause) => error(target, cause)), Effect.uninterruptible))
      const taskFile = (state: RunState, taskId: TaskId, name: string) =>
        path.join(root(state.repoRoot, state.runId), "tasks", taskId, name)
      const readPatch = Effect.fn("Report.readPatch")(function*(state: RunState, taskId: TaskId) {
        const target = taskFile(state, taskId, "diff.patch")
        return yield* Effect.gen(function*() {
          if (!(yield* fs.exists(target))) return Option.none<Uint8Array>()
          if ((yield* fs.stat(target)).type !== "File") {
            return yield* new ReportError({ path: target, issue: "Patch is not a regular file" })
          }
          const bytes = yield* fs.readFile(target)
          const digest = state.taskReports?.[taskId]?.patchSha256
          if (digest !== undefined && createHash("sha256").update(bytes).digest("hex") !== digest) {
            return yield* new ReportError({ path: target, issue: "Patch digest differs from delivery" })
          }
          return Option.some(bytes)
        }).pipe(Effect.mapError((cause) => error(target, cause)))
      })
      return Report.of({
        readPatch,
        eventSize: (state, taskId) => {
          const target = taskFile(state, taskId, "events.jsonl")
          return Effect.gen(function*() {
            return (yield* fs.exists(target)) ? Number(ByteSize.toBigInt((yield* fs.stat(target)).size)) : 0
          }).pipe(Effect.mapError((cause) => error(target, cause)))
        },
        lastEvent: (state, taskId, offset = 0) => {
          const target = path.join(root(state.repoRoot, state.runId), "tasks", taskId, "events.jsonl")
          return Effect.gen(function*() {
            if (!(yield* fs.exists(target))) return Option.none<AgentEvent>()
            return yield* fs.stream(target, { offset }).pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runFoldEffect(
                () => Option.none<AgentEvent>(),
                (last, line) =>
                  line === "" ? Effect.succeed(last) : Effect.gen(function*() {
                    const json = yield* Effect.try({
                      try: (): unknown => JSON.parse(line),
                      catch: (cause) => new ReportError({ path: target, issue: String(cause) }),
                    })
                    return Option.some(yield* Schema.decodeUnknownEffect(events)(json))
                  }),
              ),
            )
          }).pipe(Effect.mapError((cause) => error(target, cause)))
        },
        append: (state, taskId, event) => {
          const target = path.join(root(state.repoRoot, state.runId), "tasks", taskId, "events.jsonl")
          return Effect.gen(function*() {
            const encoded = yield* Schema.encodeEffect(events)(event)
            yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 })
            yield* fs.writeFileString(target, `${JSON.stringify(encoded)}\n`, { flag: "a", mode: 0o600 })
          }).pipe(Effect.mapError((cause) => error(target, cause)), Effect.uninterruptible)
        },
        patch: (state, taskId, diff) => {
          const target = taskFile(state, taskId, "diff.patch")
          return Effect.gen(function*() {
            yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 })
            yield* fs.writeFile(`${target}.tmp`, diff, { mode: 0o600 })
            yield* fs.rename(`${target}.tmp`, target)
          }).pipe(Effect.mapError((cause) => error(target, cause)), Effect.uninterruptible)
        },
        save: (state) =>
          Effect.gen(function*() {
            const report = new RunReport({
              ...state,
              worktrees: Object.fromEntries(
                Object.entries(state.worktrees).map(([id, w]) => [id, { path: w.path, branch: w.branch }]),
              ),
            })
            const encoded = yield* Schema.encodeEffect(codec)(report).pipe(Effect.orDie)
            const dir = root(state.repoRoot, state.runId)
            yield* atomic(path.join(dir, "report.md"), markdown(report))
            yield* atomic(path.join(dir, "report.json"), JSON.stringify(encoded, null, 2))
          }).pipe(Effect.uninterruptible),
        load: (repoRoot, runId) => {
          const target = path.join(root(repoRoot, runId), "report.json")
          return Effect.gen(function*() {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
              return yield* new ReportError({ path: target, issue: "Invalid run ID" })
            }
            const content = yield* fs.readFileString(target).pipe(Effect.mapError((cause) => error(target, cause)))
            const json = yield* Effect.try({
              try: (): unknown => JSON.parse(content),
              catch: (cause) => new ReportError({ path: target, issue: String(cause) }),
            })
            const report = yield* Schema.decodeUnknownEffect(codec)(json).pipe(
              Effect.mapError((cause) => error(target, cause)),
            )
            if (report.runId !== runId || report.repoRoot !== repoRoot) {
              return yield* new ReportError({ path: target, issue: "Report identity differs from repository" })
            }
            const stateFile = path.join(root(repoRoot, runId), "state.json")
            const stateText = yield* fs.readFileString(stateFile).pipe(
              Effect.mapError((cause) => error(stateFile, cause)),
            )
            const stateJson = yield* Effect.try({
              try: (): unknown => JSON.parse(stateText),
              catch: (cause) => new ReportError({ path: stateFile, issue: String(cause) }),
            })
            const state = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(RunState))(stateJson).pipe(
              Effect.mapError((cause) => error(stateFile, cause)),
            )
            const expected = yield* Schema.encodeEffect(codec)(
              new RunReport({
                ...state,
                worktrees: Object.fromEntries(
                  Object.entries(state.worktrees).map(([id, w]) => [id, { path: w.path, branch: w.branch }]),
                ),
              }),
            ).pipe(Effect.mapError((cause) => error(target, cause)))
            const actual = yield* Schema.encodeEffect(codec)(report).pipe(
              Effect.mapError((cause) => error(target, cause)),
            )
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              return yield* new ReportError({
                path: target,
                issue: "Report differs from durable state; resume to reconcile",
              })
            }
            const mdFile = path.join(root(repoRoot, runId), "report.md")
            const md = yield* fs.readFileString(mdFile).pipe(Effect.mapError((cause) => error(mdFile, cause)))
            if (md !== markdown(report)) {
              return yield* new ReportError({ path: mdFile, issue: "Markdown differs from JSON; resume to reconcile" })
            }
            for (const task of report.tasks) {
              if (report.status[task.id]?._tag === "succeeded") {
                const patch = path.join(root(repoRoot, runId), "tasks", task.id, "diff.patch")
                if (
                  Option.isNone(yield* readPatch(state, task.id))
                ) return yield* new ReportError({ path: patch, issue: "Successful task has no saved patch" })
              }
            }
            return report
          })
        },
      })
    }),
  )
}
