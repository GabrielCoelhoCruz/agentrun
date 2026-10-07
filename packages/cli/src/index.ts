import {
  Agents,
  diagnostics,
  markdown,
  Report,
  RunLock,
  Runner,
  RunReport,
  RunState,
  StateStore,
  TaskFile,
  Worktrees,
} from "@agentrun/core"
import { Clock, Console, Effect, Exit, Fiber, FileSystem, Layer, Logger, Option, Schema, Stream } from "effect"
import type { Runtime } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { promisify } from "node:util"
import packageJson from "../package.json" with { type: "json" }
import { diagnostic, restoreTerminal, safeText } from "./ui/output.js"
import { panelScoped, progress } from "./ui/Panel.js"

export const version = packageJson.version
const exec = promisify(execFile)
export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  message: Schema.String,
  code: Schema.Int,
}) {}
const bad = (cause: unknown) => new CliFailure({ message: String(cause), code: 2 })
const failed = (cause: unknown) => new CliFailure({ message: String(cause), code: 1 })
const git = (args: string[], cwd = process.cwd()) =>
  Effect.tryPromise({
    try: () => exec("git", args, { cwd }),
    catch: bad,
  }).pipe(Effect.map((result) => result.stdout.trim()))
const write = (value: unknown, json: boolean) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) =>
        process.stdout.write(
          `${json ? JSON.stringify(value) : typeof value === "string" ? safeText(value) : JSON.stringify(value)}\n`,
          (error) => error ? reject(error) : resolve(),
        )
      ),
    catch: failed,
  })
const common = {
  concurrency: Flag.Int("concurrency").pipe(Flag.withSchema(Schema.Int.check(Schema.isGreaterThan(0))), Flag.optional),
  keepWorktrees: Flag.Boolean("keep-worktrees").pipe(Flag.withDefault(false)),
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
  loadProjectSettings: Flag.Boolean("load-project-settings").pipe(Flag.withDefault(false)).pipe(Flag.withDescription(
    "Enable Claude project/local settings and Pi .pi/settings.json. Pi extensions and context files stay disabled.",
  )),
}
type Options = {
  readonly concurrency: Option.Option<number>
  readonly keepWorktrees: boolean
  readonly json: boolean
  readonly dryRun: boolean
  readonly loadProjectSettings: boolean
}
const RunId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/, { message: "Invalid run ID" }))

export const execute = Effect.fn("cli.execute")(
  function*(state: RunState, options: Options, retryFailed = false, resumeExisting = false) {
    yield* Schema.decodeUnknownEffect(RunId)(state.runId).pipe(Effect.mapError(bad))
    const agents = yield* Agents
    const fs = yield* FileSystem.FileSystem
    const ignore = yield* fs.readFileString(`${state.repoRoot}/.gitignore`).pipe(Effect.catch(() => Effect.succeed("")))
    if (!ignore.split(/\r?\n/).some((line) => line === ".agentrun/" || line === ".agentrun")) {
      diagnostic("Suggestion: add .agentrun/ to .gitignore.\n")
    }
    if (options.loadProjectSettings) {
      diagnostic("Warning: project settings can enable hooks and project configuration.\n")
    }
    const run = Effect.gen(function*() {
      const lock = yield* RunLock
      yield* lock.acquire(state.repoRoot)
      const store = yield* StateStore
      const candidate = resumeExisting ? yield* store.load(state.runId) : state
      if (candidate.runId !== state.runId || candidate.repoRoot !== state.repoRoot) {
        return yield* bad("Saved run identity differs from repository")
      }
      if (candidate.tasks.some((task) => task.tools === "read-only") && options.loadProjectSettings) {
        return yield* bad("read-only tools cannot load project settings")
      }
      const services = Layer.mergeAll(
        Report.layer,
        Layer.succeed(Agents, agents),
        Layer.succeed(StateStore, store),
        Layer.succeed(RunLock, { acquire: () => Effect.void }),
        Worktrees.layer({
          repoRoot: state.repoRoot,
          runId: state.runId,
          home: homedir(),
          keepWorktrees: options.keepWorktrees,
        }),
      )
      const program = Effect.gen(function*() {
        if (!resumeExisting) {
          const directory = `${state.repoRoot}/.agentrun/runs/${state.runId}`
          if (yield* fs.exists(directory)) {
            return yield* bad(`Run ID already exists: ${state.runId}; use resume with this exact ID`)
          }
          const worktrees = yield* Worktrees
          const branches = new Set(
            (yield* git(["for-each-ref", "--format=%(refname)", "refs/heads"], state.repoRoot)).split("\n"),
          )
          for (const task of candidate.tasks) {
            const located = worktrees.locate(task.id)
            if (branches.has(`refs/heads/${located.branch}`) || (yield* fs.exists(located.path))) {
              return yield* bad(`Worktree collision: ${located.branch}; choose a different run ID`)
            }
          }
          yield* fs.makeDirectory(`${state.repoRoot}/.agentrun/runs`, { recursive: true })
          yield* fs.makeDirectory(directory).pipe(
            Effect.mapError((error) =>
              error.reason._tag === "AlreadyExists" ? bad(`Run ID already exists: ${state.runId}`) : error
            ),
          )
          yield* store.save(candidate)
        }
        const panel = !options.json && process.stdout.isTTY ? yield* panelScoped(candidate) : undefined
        const runner = yield* Runner
        const events = yield* runner.subscribe
        const consumer = yield* Stream.runForEach(
          events.pipe(Stream.takeUntil((event) => event._tag === "RunFinished")),
          (event) =>
            panel !== undefined
              ? Effect.sync(() => {
                panel.event(event)
              })
              : event._tag === "TaskWarning"
              ? Effect.sync(() => {
                diagnostic(`${event.message}\n`)
              })
              : write(options.json ? event : progress(event), options.json),
        ).pipe(Effect.forkScoped)
        const final = yield* runner.run(candidate).pipe(Effect.onExit(() => Fiber.join(consumer).pipe(Effect.orDie)))
        if (!Object.values(final.status).every((status) => status._tag === "succeeded")) {
          return yield* failed("Run has failed or unfinished tasks")
        }
      }).pipe(Effect.provide(
        Runner.layer({
          concurrency: Option.getOrElse(options.concurrency, () => state.concurrency),
          retryFailed,
          setupInAgent: true,
          loadProjectSettings: options.loadProjectSettings,
        }).pipe(Layer.provideMerge(services)),
      ))
      yield* program
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(
        StateStore.layerFile({ repoRoot: state.repoRoot }),
        RunLock.layer({ home: homedir() }),
      )),
      Effect.mapError((error) => error instanceof CliFailure ? error : failed(error)),
    )
    yield* run
  },
)

export const run = Effect.fn("cli.run")(
  function*(
    options: Options & {
      readonly file: string
      readonly base: Option.Option<string>
      readonly runId?: Option.Option<string>
    },
  ) {
    if (options.runId !== undefined && Option.isSome(options.runId)) {
      yield* Schema.decodeUnknownEffect(RunId)(options.runId.value).pipe(Effect.mapError(bad))
    }
    const agents = yield* Agents
    const fs = yield* FileSystem.FileSystem
    const repoRoot = yield* git(["rev-parse", "--show-toplevel"])
    const realRoot = yield* fs.realPath(repoRoot).pipe(Effect.mapError(bad))
    const content = yield* fs.readFileString(options.file).pipe(Effect.mapError(bad))
    const claude = agents.get("claude-code")
    const pi = agents.get("pi")
    if (Option.isNone(claude) || Option.isNone(pi)) return yield* bad("Required provider is unavailable")
    const parsed = yield* TaskFile.parse({
      path: options.file,
      content,
      capabilities: {
        "claude-code": claude.value.capabilities,
        pi: pi.value.capabilities,
      },
    }).pipe(Effect.mapError(bad))
    if (options.loadProjectSettings && parsed.tasks.some((task) => task.tools === "read-only")) {
      return yield* bad("read-only tools cannot load project settings")
    }
    const base = Option.getOrElse(options.base, () => parsed.base)
    const baseSha = yield* git(["rev-parse", "--verify", `${base}^{commit}`], realRoot)
    if (options.dryRun) {
      return yield* write({
        _tag: "DryRun",
        baseSha,
        tasks: parsed.tasks,
        concurrency: Option.getOrElse(options.concurrency, () => parsed.concurrency),
      }, options.json)
    }
    const now = yield* Clock.currentTimeMillis
    const runId = Option.getOrElse(
      options.runId ?? Option.none(),
      () => `${new Date(now).toISOString().replace(/[-:.]/g, "")}-${randomBytes(8).toString("hex")}`,
    )
    const state = new RunState({
      version: 1,
      runId,
      repoRoot: realRoot,
      base,
      baseSha,
      concurrency: Option.getOrElse(options.concurrency, () => parsed.concurrency),
      ...(Option.isSome(parsed.setup) ? { setup: parsed.setup.value } : {}),
      tasks: parsed.tasks,
      status: Object.fromEntries(parsed.tasks.map((task) => [task.id, { _tag: "pending" as const }])),
      worktrees: {},
    })
    yield* execute(state, options)
  },
)

export const resume = Effect.fn("cli.resume")(
  function*(options: Options & { readonly runId: Option.Option<string>; readonly retryFailed: boolean }) {
    const fs = yield* FileSystem.FileSystem
    const root = yield* git(["rev-parse", "--show-toplevel"])
    const repoRoot = yield* fs.realPath(root).pipe(Effect.mapError(bad))
    const loaded = yield* Effect.gen(function*() {
      const store = yield* StateStore
      const id = Option.isSome(options.runId) ? options.runId : yield* store.latest
      if (Option.isNone(id)) return yield* bad("No saved run found")
      yield* Schema.decodeUnknownEffect(RunId)(id.value).pipe(Effect.mapError(bad))
      const state = yield* store.load(id.value).pipe(Effect.mapError(bad))
      if (state.runId !== id.value || state.repoRoot !== repoRoot) {
        return yield* bad("Saved run identity differs from repository")
      }
      return state
    }).pipe(Effect.provide(StateStore.layerFile({ repoRoot })))
    if (options.dryRun) {
      return yield* write(
        { _tag: "DryRun", runId: loaded.runId, baseSha: loaded.baseSha, tasks: loaded.tasks },
        options.json,
      )
    }
    yield* execute(loaded, options, options.retryFailed, true)
  },
)

export const report = Effect.fn("cli.report")(
  function*(options: { readonly runId: Option.Option<string>; readonly json: boolean }) {
    const fs = yield* FileSystem.FileSystem
    const repoRoot = yield* fs.realPath(yield* git(["rev-parse", "--show-toplevel"])).pipe(Effect.mapError(bad))
    yield* Effect.gen(function*() {
      const store = yield* StateStore
      const id = Option.isSome(options.runId) ? options.runId : yield* store.latest
      if (Option.isNone(id)) return yield* bad("No saved run found")
      const saved = yield* (yield* Report).load(repoRoot, id.value).pipe(Effect.mapError(bad))
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(RunReport))(saved).pipe(Effect.mapError(bad))
      yield* write(options.json ? encoded : markdown(saved), options.json)
    }).pipe(Effect.provide(Layer.merge(StateStore.layerFile({ repoRoot }), Report.layer)))
  },
)

export const doctor = Effect.fn("cli.doctor")(
  function*({ json }: { readonly json: boolean }, check: ReturnType<typeof diagnostics> = diagnostics(process.cwd())) {
    const report = yield* check
    yield* write(report, json)
    if (!report.complete) {
      return yield* failed("Doctor is incomplete; check runtime, lock utility and provider auth reasons")
    }
  },
)

export const command = Command.make("agentrun").pipe(Command.withSubcommands([
  Command.make(
    "run",
    {
      ...common,
      file: Argument.String("TASKS.md"),
      base: Flag.String("base").pipe(Flag.optional),
      runId: Flag.String("run-id").pipe(Flag.withSchema(RunId), Flag.optional),
    },
    run,
  ),
  Command.make("resume", {
    ...common,
    runId: Argument.String("run-id").pipe(Argument.withSchema(RunId), Argument.optional),
    retryFailed: Flag.Boolean("retry-failed").pipe(Flag.withDefault(false)),
  }, resume),
  Command.make("report", {
    runId: Argument.String("run-id").pipe(Argument.withSchema(RunId), Argument.optional),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
  }, report),
  Command.make(
    "doctor",
    { json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
    (options) => doctor(options),
  ),
]))

const cliConsole = {
  ...console,
  error: (...args: ReadonlyArray<unknown>) => diagnostic(`${args.map(String).join(" ")}\n`),
  warn: (...args: ReadonlyArray<unknown>) => diagnostic(`${args.map(String).join(" ")}\n`),
  info: (...args: ReadonlyArray<unknown>) => diagnostic(`${args.map(String).join(" ")}\n`),
  debug: (...args: ReadonlyArray<unknown>) => diagnostic(`${args.map(String).join(" ")}\n`),
  log: (...args: ReadonlyArray<unknown>) => {
    const explicitHelp = process.argv.some((arg) => ["--help", "-h", "--version", "-v", "--completions"].includes(arg))
    if (explicitHelp) process.stdout.write(`${args.map(String).join(" ")}\n`)
    else diagnostic(`${args.map(String).join(" ")}\n`)
  },
}
export const forceExitOnSecondInterrupt = Effect.acquireRelease(
  Effect.sync(() => {
    let first: number | undefined
    const onInterrupt = () => {
      const now = performance.now()
      if (first !== undefined && now - first <= 3000) {
        restoreTerminal()
        process.stderr.write("Warning: forced exit. Resume this run to finish cleanup.\n", () => process.exit(130))
      } else first = now
    }
    process.on("SIGINT", onInterrupt)
    return onInterrupt
  }),
  (listener) =>
    Effect.sync(() => {
      process.removeListener("SIGINT", listener)
    }),
)
export const main = Command.run(command, { version, renderErrors: true }).pipe(
  (program) => Effect.scoped(forceExitOnSecondInterrupt.pipe(Effect.andThen(program))),
  Effect.provideService(Console.Console, cliConsole),
  Effect.catch((error) =>
    Effect.sync(() => {
      const code = error instanceof CliFailure ? error.code : 2
      process.exitCode = code
      diagnostic(`${error instanceof CliFailure ? error.message : String(error)}\n`)
    })
  ),
  Effect.provide(Logger.layer([Logger.make(({ message }) => {
    diagnostic(`${String(message)}\n`)
  })])),
)
export const teardown: Runtime.Teardown = (exit, onExit) => {
  onExit(Exit.hasInterrupts(exit) ? 130 : Exit.isFailure(exit) ? 1 : Number(process.exitCode ?? 0))
}
