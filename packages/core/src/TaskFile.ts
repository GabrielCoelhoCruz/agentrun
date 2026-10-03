import { Duration, Effect, Option, Predicate, Schema, SchemaIssue } from "effect"
import { isMap, isScalar, LineCounter, parseDocument } from "yaml"
import type { AgentCapabilities } from "./domain/Agent.js"
import { TaskFileError, UnsupportedOption } from "./domain/Errors.js"
import { AgentId, Task, TaskId } from "./domain/Task.js"

const taskOptions = {
  agent: Schema.optional(AgentId),
  model: Schema.optional(Schema.String),
  maxTurns: Schema.optional(Schema.Int),
  maxBudgetUsd: Schema.optional(Schema.Finite),
  stallTimeout: Schema.optional(Schema.DurationFromString),
  maxDuration: Schema.optional(Schema.DurationFromString),
}

const Frontmatter = Schema.Struct({
  base: Schema.optional(Schema.String),
  concurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  setup: Schema.optional(Schema.String),
  ...taskOptions,
})

const Overrides = Schema.Struct({
  ...taskOptions,
  maxTurns: Schema.optional(Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int))),
  maxBudgetUsd: Schema.optional(Schema.FiniteFromString),
})

const Heading = Schema.String.check(Schema.isPattern(/^##\s+[^:]+:\s*\S.*$/, {
  message: "expected heading ## <id>: <title>",
}))

const Tasks = Schema.Array(Task).check(Schema.isMinLength(1, { message: "expected at least one task" }))

const issueToError = (path: string, lines: ReadonlyMap<string, number>, fallback: number) =>
(
  error: Schema.SchemaError,
): TaskFileError => {
  const key = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues[0]?.path?.[0]
  const line = Predicate.isString(key) ? lines.get(key) ?? fallback : fallback
  return new TaskFileError({ path, line, message: `${path}:${line}: ${error.message}` })
}

export class TaskFile extends Schema.Class<TaskFile>("agentrun/TaskFile")({
  base: Schema.String,
  concurrency: Schema.Int,
  setup: Schema.Option(Schema.String),
  tasks: Schema.Array(Task),
}) {
  static readonly parse = Effect.fn("TaskFile.parse")(function*(input: {
    path: string
    content: string
    capabilities: Record<AgentId, AgentCapabilities>
  }): Effect.fn.Return<TaskFile, TaskFileError | UnsupportedOption> {
    const { path, content, capabilities } = input
    const lines = content.split(/\r?\n/)
    const frontLines = new Map<string, number>()
    let start = 0
    let frontInput: unknown = {}

    if (lines[0] === "---") {
      const end = lines.findIndex((line, index) => index > 0 && line === "---")
      if (end < 0) {
        return yield* new TaskFileError({
          path,
          line: 1,
          message: `${path}:1: expected closing frontmatter delimiter ---`,
        })
      }
      const lineCounter = new LineCounter()
      const document = parseDocument(lines.slice(1, end).join("\n"), { lineCounter })
      const yamlError = document.errors[0]
      if (yamlError) {
        const line = (yamlError.linePos?.[0].line ?? lineCounter.linePos(yamlError.pos[0]).line) + 1
        return yield* new TaskFileError({ path, line, message: `${path}:${line}: ${yamlError.message}` })
      }
      if (isMap(document.contents)) {
        for (const pair of document.contents.items) {
          if (isScalar(pair.key) && Predicate.isString(pair.key.value)) {
            frontLines.set(pair.key.value, lineCounter.linePos(pair.key.range?.[0] ?? 0).line + 1)
          }
        }
      }
      frontInput = yield* Effect.try({
        try: (): unknown => document.toJS(),
        catch: (cause) => new TaskFileError({ path, line: 2, message: `${path}:2: ${String(cause)}` }),
      })
      start = end + 1
    }

    const front = yield* Schema.decodeUnknownEffect(Frontmatter)(frontInput, { onExcessProperty: "error" }).pipe(
      Effect.mapError(issueToError(path, frontLines, 1)),
    )
    const { base, concurrency, setup, ...defaults } = front
    const tasks: Array<Task> = []
    const ids = new Set<TaskId>()

    for (let index = start; index < lines.length; index++) {
      const text = lines[index] ?? ""
      if (!/^##(?:\s|$)/.test(text)) continue
      const line = index + 1
      const heading = yield* Schema.decodeEffect(Heading)(text).pipe(
        Effect.mapError(issueToError(path, frontLines, line)),
      )
      const colon = heading.indexOf(":")
      const id = yield* Schema.decodeEffect(TaskId.check(Schema.makeFilter(
        (value) => !ids.has(value) || `duplicate task id "${value}"`,
      )))(heading.slice(2, colon).trim()).pipe(
        Effect.mapError(issueToError(path, new Map(), line)),
      )
      ids.add(id)
      const title = heading.slice(colon + 1).trim()
      const overrideInput: Record<string, string> = {}
      const overrideLines = new Map<string, number>()
      let bodyStart = index + 1
      for (; bodyStart < lines.length; bodyStart++) {
        if (/^##(?:\s|$)/.test(lines[bodyStart] ?? "")) break
        const override = /^([^:\s][^:]*):\s*(.*)$/.exec(lines[bodyStart] ?? "")
        const key = override?.[1]?.trim()
        if (key === undefined) break
        overrideInput[key] = override?.[2] ?? ""
        overrideLines.set(key, bodyStart + 1)
      }
      const overrides = yield* Schema.decodeEffect(Overrides)(overrideInput, { onExcessProperty: "error" }).pipe(
        Effect.mapError(issueToError(path, overrideLines, line)),
      )
      let bodyEnd = bodyStart
      while (bodyEnd < lines.length && !/^##(?:\s|$)/.test(lines[bodyEnd] ?? "")) bodyEnd++
      index = bodyEnd - 1
      while (bodyStart < bodyEnd && (lines[bodyStart] ?? "").trim() === "") bodyStart++
      while (bodyEnd > bodyStart && (lines[bodyEnd - 1] ?? "").trim() === "") bodyEnd--
      const prompt = yield* Schema.decodeEffect(Schema.NonEmptyString)(
        lines.slice(bodyStart, bodyEnd).join("\n"),
      ).pipe(
        Effect.mapError(issueToError(path, new Map(), line)),
      )
      const options = { ...defaults, ...overrides }
      const agent = options.agent ?? "claude-code"
      const capabilityOptions: ReadonlyArray<UnsupportedOption["option"]> = ["maxBudgetUsd", "maxTurns", "model"]
      for (const option of capabilityOptions) {
        if (options[option] !== undefined && !capabilities[agent][option]) {
          const optionLine = overrideLines.get(option) ?? frontLines.get(option) ?? line
          return yield* new UnsupportedOption({
            path,
            line: optionLine,
            taskId: id,
            agent,
            option,
            message: `${path}:${optionLine}: task "${id}": ${option} is not supported by agent "${agent}"`,
          })
        }
      }
      const taskLines = new Map([...frontLines, ...overrideLines])
      const task = yield* Schema.decodeEffect(Task)({
        ...options,
        id,
        title,
        prompt,
        agent,
        stallTimeout: options.stallTimeout ?? Duration.minutes(5),
        maxDuration: options.maxDuration ?? Duration.minutes(60),
      }).pipe(Effect.mapError(issueToError(path, taskLines, line)))
      tasks.push(task)
    }

    const validatedTasks = yield* Schema.decodeEffect(Tasks)(tasks).pipe(
      Effect.mapError(issueToError(path, new Map(), 1)),
    )
    return new TaskFile({
      base: base ?? "HEAD",
      concurrency: concurrency ?? 2,
      setup: Option.fromUndefinedOr(setup),
      tasks: validatedTasks,
    })
  })
}
