# agentrun. Specification for v1

Version 1, frozen on 2026-10-02 after two external reviews. Author: Gabriel, with assisted review.
From here on, change this document only through an ADR in `docs/adr/` that names the number of the affected decision. The items marked "spike C1" are the only open gaps. The spike log closes them.
Project: a local runner that runs code agents in parallel, one git worktree per task, with clean cancellation and `resume`. Written in Effect v4.

## How to read this document

The document has three parts. Read them in order the first time. After that, use each part on its own.

| Part | Type | Question it answers |
|---|---|---|
| A. Decisions | explanation | Why does the project have this shape? |
| B. Contracts | reference | What is the exact shape of each piece? |
| C. Plan | step by step | What do I do first, and how do I know it is done? |

Every API named here was verified against the packages published on 2026-10-02. B1 lists the versions. The appendix lists the sources.

---

# Part A. Decisions

## A1. Goal and thesis

You point `agentrun` at a `TASKS.md` file. It creates one worktree per task, runs a code agent in each worktree, shows progress in the terminal, and at the end delivers a report with status, diff, and cost per task. If you press Ctrl-C, it stops the agents and saves the state. You resume later with `agentrun resume`.

The thesis of the project is this. Typed errors, dependency injection through Layer, and the concurrency built-ins of Effect make agent orchestration predictable. They also make the code easy to maintain for people and for agents.

The difference from the earlier draft is the focus on several agent providers. The v1 delivers two providers behind a single contract. One provider alone would be a false abstraction. Three would be too much scope.

## A2. Scope of v1

In scope:

1. `agentrun run TASKS.md`. Parses the file with Schema. Typed, readable configuration error.
2. One worktree per task, outside the repository, with cleanup through Scope.
3. Two agent providers, Claude Code and Pi. Selection per task.
4. Parallelism with a configurable limit.
5. Progress panel in the terminal in plain ANSI. Simple logs when there is no TTY.
6. Ctrl-C interrupts the agents, saves the state, and keeps the worktrees of the interrupted tasks.
7. `agentrun resume` resumes the `pending` and `interrupted` tasks, and with a flag, the `failed` tasks.
8. Final report in markdown and JSON, with diff per task, duration, and cost.
9. `agentrun doctor` checks git, the provider binaries, and authentication.

Out of scope, with a public roadmap:

- A third provider (Codex). The contract already fits it. See B5.
- Continuation of the agent session on `resume`. The v1 restarts the task in the kept worktree.
- SQLite, queryable event log, web dashboard, MCP server, GitHub issues integration, automatic evaluation of the result.

## A3. Decisions

Each decision records what was chosen and why. Change a decision only when the reason no longer holds.

**D1. The central contract is a stream of normalized events.** A provider is an `AgentAdapter` value with `run(input) => Stream<AgentEvent, AgentError>`. The runner never sees stdout, JSONL, or SDK messages. It sees `AgentEvent`. This is what lets you swap providers without touching the runner and, later, expose the runner as an MCP server.

**D2. SDK or subprocess is an internal detail of the adapter.** All three providers offer both paths. Claude Code has `@anthropic-ai/claude-agent-sdk` and `claude -p --output-format stream-json`. Pi has `@earendil-works/pi-coding-agent` and `pi --mode json`. Codex has `@openai/codex-sdk` and `codex exec --json`. In Effect both paths become the same type. An `AsyncIterable` becomes `Stream.fromAsyncIterable`. A process becomes `ChildProcessSpawner.streamLines`. The choice per provider in v1:

| Provider | Path in v1 | Reason |
|---|---|---|
| Claude Code | SDK (`query()`) | Typed messages, `abortController`, `maxBudgetUsd`, `settingSources: []`. The SDK already runs the binary in a subprocess, so the isolation is the same. |
| Pi | Decided by spike C1 | The SDK runs the agent inside your process. It must prove that N sessions with different `cwd` values run in parallel without interference. If the spike fails, use `pi --mode json` in a subprocess. |

**D3. Capabilities declared per provider.** Not every provider accepts `maxBudgetUsd` or `maxTurns`. Each adapter declares `AgentCapabilities`. The `TASKS.md` parse fails with `UnsupportedOption` when a task asks for what the provider does not have. Nothing is ignored silently.

**D4. State in JSON, one file per run, atomic write.** `resume` needs the task list, status, attempts, worktree path, and branch. This fits in a file encoded by Schema with a `version` field. Writing to a temporary file and then `rename` avoids corruption. SQLite comes in when there is a queryable event log.

**D5. Worktrees outside the repository.** In `~/.agentrun/worktrees/<repo-hash>/<run-id>/<task-id>`. Inside the repository they pollute `git status` and confuse the agent with a nested repo.

**D6. One branch per task and per run, `agentrun/<task-id>-<short-run-id>`, created from `baseSha`.** The branch is the deliverable. The worktree is disposable. See D20 for identity.

**D7. Every write to the shared `.git` goes through a semaphore with 1 permit.** Commits inside each worktree are safe because each worktree has its own index and `HEAD`. What collides is `worktree add`, `worktree remove`, `branch`, `fetch`, `prune`, and `packed-refs`. The `Worktrees` service serializes these operations. The agent is forbidden from running `git worktree` and from running `git checkout` of another branch.

**D8. On interruption the worktree stays. On success or failure the worktree goes and the branch stays.** The release of `Effect.acquireRelease` receives the `Exit`. `Exit.hasInterrupts(exit)` decides. The `--keep-worktrees` flag keeps all of them.

**D9. The parallelism limit is a `Semaphore` in the `Runner` layer.** `Effect.forEach` with `concurrency` would already limit a single run. The semaphore exists because the future MCP server will have several callers in the same process, and they must share the same pool. Document this in the README so it does not look like excess.

**D10. Retry only before the agent starts to work.** `AgentSpawnError`, and `AgentCrashed` when the process died before the first `ToolCall`, retry with `Schedule.exponential("1 second").pipe(Schedule.jittered, Schedule.upTo({ times: 2 }))`. After the first `ToolCall` the worktree can have partial effects, and repeating the prompt repeats effects. In that case the task goes to `failed` and the worktree stays for inspection. `AgentTaskFailed` is not transient. Interruption never retries.

**D11. Two time limits per task.** Stall timeout, default 5 minutes without any `AgentEvent`. Absolute ceiling, default 60 minutes. Both are configurable in the frontmatter and per task.

**D12. Panel in plain ANSI.** Ink brings React and a reconciler, fights with stdin in raw mode, and complicates testing. The panel is a consumer of `RunEvent` in the CLI package. The core imports no terminal code.

**D13. No target project configuration loaded by the agent.** Claude Code through the SDK with `settingSources: []`. This prevents hooks and `.mcp.json` from the target repository from running without confirmation. The `--load-project-settings` flag turns it back on, with a warning.

**D14. Durations come from `Clock`, never from `Date.now()`.** This makes the timeout and retry tests deterministic with `TestClock`.

**D15. One run per repository at a time.** D7 serializes git inside one run. Two `agentrun run` commands in the same repository in different terminals still fight over the same `.git` and the same `state.json`. `run` and `resume` acquire a lock file at `~/.agentrun/locks/<repo-hash>.lock` with `Effect.acquireRelease`, opened with the `wx` flag of `FileSystem`, containing the PID. A lock whose PID no longer exists is considered stale and replaced. Fails with `RunLocked`.

**D16. The `setup` runs in `runTask`, not inside `Worktrees.acquire`.** If `setup` fails inside the acquire, the acquire fails, the release is never registered, and the worktree becomes an orphan. Outside the acquire, a `setup` failure becomes `SetupError`, the task goes to `failed`, and the worktree stays for inspection with the release already registered. The acquire of `Effect.acquireRelease` is uninterruptible by default. The `{ interruptible: true }` option exists, but it does not solve the orphan problem, so it is not the reason for the decision.

**D17. A task error does not bring down the run.** Every error in a task becomes status `failed` for that task, with a `reason`. Only errors of the whole run escape `Runner.run`. Exit code 1 comes from the statuses, not from a runner error.

**D18. The runner makes the commit. Success only after the deliverable is saved.** The spec does not require the agent to commit, and `git diff <base>...<branch>` does not see uncommitted changes or new files without `git add`. Removing a dirty worktree fails, and `--force` loses the work. So, after `Completed`, `runTask` runs `git add -A` and `git commit -m "agentrun(<task-id>): <title>"` in the worktree, if there is a change. Only then does it generate `diff.patch` with `git diff <baseSha>..<branch>`, write the task report, and mark `succeeded`. The release removes the worktree without `--force`. If removal fails, the worktree stays and the report warns.

**D19. A single state writer, and intent before resource.** Several tasks transition at the same time. With concurrent `save`, the last write erases the transition of the other. The `Runner` keeps the `RunState` in a `SynchronizedRef`. Every transition is a `SynchronizedRef.updateEffect` that updates and persists inside the same critical section. The worktree path and the branch name are deterministic from `runId` and `taskId`, and the transition to `running` writes both before `git worktree add`. So, after a crash, `reconcile` knows what to look for.

**D20. Identity per run.** Branch `agentrun/<task-id>-<short-run-id>` and directory `~/.agentrun/worktrees/<repo-hash>/<run-id>/<task-id>`. Repeating a `task-id` in another run never collides. `base` is resolved to a SHA at the start of the run and recorded as `baseSha`. `resume` uses the recorded `baseSha` and rejects `--base`. The identity of the repository is the real path of `git rev-parse --git-common-dir`, so that two worktrees of the same repository share the same lock.

**D21. Control of the process tree.** Agent tools and `setup` create child processes. Subprocess adapters use `detached: true` to create their own process group and kill the group with `process.kill(-pid, signal)`, with `forceKillAfter` to escalate from `SIGINT` to `SIGTERM` and `SIGKILL`. The `pgid` is recorded in `worktrees[taskId]`. On `resume`, if the `pgid` is still alive, the runner kills the group before it starts another agent. For Claude through the SDK, `query.close()` ends the CLI, and the CLI ends the process tree of the Bash commands when it receives `SIGTERM`. Spike C1 observes this.

**D22. Explicit permission policy per adapter.** `acceptEdits` does not unlock Bash, and without `canUseTool` a permission request falls back to the mode. Claude uses `permissionMode: "dontAsk"`, an explicit list in `allowedTools`, and scoped rules in `disallowedTools`, which apply in any mode. Pi uses an in-memory `settingsManager`, a `resourceLoader` with discovery of extensions, skills, and context files turned off, and an explicit `tools` list. Spike C1 confirms the names of these options and whether built-in tools ask for approval. The tool list is configurable in the frontmatter under `allowedTools`.

## A4. Risks and mitigations

| # | Risk | Mitigation | Where |
|---|---|---|---|
| 1 | Permission prompt blocks the agent | For Claude, `permissionMode: "acceptEdits"` or `allowedTools`, plus `--permission-prompts none` in the CLI (needs Claude Code 2.1.259+). For Pi, check the equivalent flag in the spike. | B6 |
| 2 | A stuck agent holds the process | Stall timeout and absolute ceiling (D11). `maxTurns` and `maxBudgetUsd` on Claude. | B4 |
| 3 | Cancellation loses the result | For Claude, `SIGTERM` exits with 143 and no `result`. Through the SDK, `abortController.abort()` and then `query.close()`. Through the CLI, `SIGINT` first and `SIGTERM` after a grace period. | B6 |
| 4 | Two `git worktree add` at the same time can collide on refs or locks | Not demonstrated. The 1-permit semaphore (D7) is a cheap precaution. Test C3.5 runs two `acquire` calls in parallel and records what happens without the semaphore, for documentation. | B4 |
| 11 | Agent work lost in cleanup | Commit by the runner and success only after the deliverable is saved (D18). | B4 |
| 12 | State transition lost to a concurrent write | Single writer with `SynchronizedRef` (D19). | B4 |
| 13 | Child processes survive cancellation or crash | Process group and recorded `pgid` (D21). | B6 |
| 5 | Orphan worktree after crash | `git worktree prune` and comparison of `git worktree list --porcelain` with the state at the start of each run. | B4 |
| 6 | `SIGKILL` does not run the finalizer | `resume` reconciles from disk and git. Test C3.4. | C3 |
| 7 | Event volume blows up memory | No partial events. Ring buffer of 1000 lines per task in the panel. Full log in `events.jsonl`. | B7 |
| 8 | Provider version changes the protocol | `agentrun doctor` checks the minimum version. Claude sends `capabilities` in `system/init`. Fixtures recorded from real runs. | B8, C3 |
| 9 | Pi in process interferes between sessions | Spike C1 before choosing the path. | C1 |
| 10 | v3-era packages installed by mistake | `@effect/platform`, `@effect/cli`, and `@effect/sql` at 0.x are v3. Dependency lint in CI. | B1 |

---

# Part B. Contracts

## B1. Stack

| Package | Verified version | Use |
|---|---|---|
| `effect` | 4.0.0 (`latest`) | Core. Includes `effect/cli`, `effect/process`, `effect/testing`, `effect/persistence`. |
| `@effect/platform-node` | 4.0.0 | `NodeServices.layer` (FileSystem, Path, ChildProcessSpawner), `NodeRuntime.runMain`. |
| `@effect/vitest` | 4.0.0 | `it.effect`, `it.live`, `it.layer`, `TestClock`. |
| `@effect/language-service` | 0.87 | TypeScript plugin. |
| `@effect/eslint-plugin` | 0.3 | Lint. |
| `@anthropic-ai/claude-agent-sdk` | 0.3.287 | Claude Code adapter. |
| `@earendil-works/pi-coding-agent` | 1.0.0 | Pi adapter, if the spike approves the SDK. The `@mariozechner/*` scope is legacy. |
| `yaml` | 2.9 | `TASKS.md` frontmatter. |
| `typescript` | 7.0, strict | Effect v4 requires 5.9 or newer and recommends 7 for the tooling. Flags: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. |
| `vitest` | 5.0 | `@effect/vitest@4` requires `>=5 <6`. |
| `eslint` | 10 | With `@effect/eslint-plugin`. The plugin declares no peer. Compatibility with eslint 10 is checked in step 1. If it breaks, switch to `oxlint`, which is what Lalph uses. |
| `tsdown` | 0.23 | Build of both packages. |
| Node | 24 LTS | Effect v4 requires 22.18 or newer. `.nvmrc` and `engines` point to 24. |
| `pi` (global binary) | 1.0.0, same as `latest` | Spike C1 and Pi adapter. Installed at `~/.local/lib/node_modules/@earendil-works/pi-coding-agent`. |

Version policy. Always install the `latest` of each package. The `pnpm-lock.yaml` pins the exact version, so the build is reproducible. Weekly Renovate with grouped PRs keeps everything at `latest`, and CI decides whether the upgrade goes in. The table above records what was `latest` on 2026-10-02 and is not a pin. Only two real constraints exist, and they come from the peers. `@effect/vitest@4` requires `effect ^4` and `vitest 5`.

Names on npm, free on 2026-10-02: `agentrun` (CLI) and `@agentrun/core`.

Do not install `@effect/platform`, `@effect/cli`, or `@effect/sql` at 0.x. In v4 these modules live inside `effect`.

## B2. `TASKS.md` format

```md
---
base: main
concurrency: 3
agent: claude-code
setup: pnpm install
stallTimeout: 5 minutes
maxDuration: 60 minutes
---

## fix-login: Fix the login timeout
agent: pi
maxTurns: 40

The POST /login endpoint returns 504 when Redis is slow.
Add a 2s timeout to the client and a test.

## add-healthcheck: /health endpoint

Create GET /health that returns 200 and the package version.
```

Rules:

- Optional YAML frontmatter. Keys: `base` (default `HEAD`), `concurrency` (default 2), `agent` (default `claude-code`), `setup` (command run in each worktree after creation), `stallTimeout`, `maxDuration`, `model`, `maxTurns`, `maxBudgetUsd`.
- Each task starts with `## <id>: <title>`. `id` is kebab-case, unique in the file, and becomes the branch name.
- `key: value` lines right after the title override the frontmatter for that task. Same keys as the frontmatter, except `base`, `concurrency`, and `setup`.
- The rest of the section, up to the next `##`, is the prompt. It cannot be empty.
- Every unknown key is an error.

A parse error is a `TaskFileError` with `path`, `line`, and `message`. The `message` of the Effect `SchemaError` is already formatted for humans. Example of the expected output:

```
TASKS.md:14: task "fix-login": maxBudgetUsd is not supported by agent "pi"
```

## B3. Domain model

Main types. The order here is the order to write them in the code.

```ts
import { Schema } from "effect"

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export const AgentId = Schema.Literals(["claude-code", "pi"])

export class Task extends Schema.Class<Task>("agentrun/Task")({
	id: TaskId,
	title: Schema.String,
	prompt: Schema.NonEmptyString,
	agent: AgentId,
	model: Schema.optional(Schema.String),
	maxTurns: Schema.optional(Schema.Int),
	maxBudgetUsd: Schema.optional(Schema.Finite),
	stallTimeout: Schema.Duration,
	maxDuration: Schema.Duration,
}) {}
```

State of a task. A state machine, not booleans.

```ts
export const TaskStatus = Schema.Union([
	Schema.TaggedStruct("pending", {}),
	Schema.TaggedStruct("running", { attempt: Schema.Int, startedAt: Schema.DateTimeUtc }),
	Schema.TaggedStruct("succeeded", { durationMs: Schema.Int, costUsd: Schema.optional(Schema.Finite) }),
	Schema.TaggedStruct("failed", { attempt: Schema.Int, reason: Schema.String }),
	Schema.TaggedStruct("interrupted", { attempt: Schema.Int }),
])
```

Allowed transitions. Any other transition is a defect.

| From | To | Who triggers | Persisted before continuing |
|---|---|---|---|
| `pending` | `running` | runner acquires worktree | yes |
| `running` | `succeeded` | `AgentEvent.Completed` without error | yes |
| `running` | `failed` | `AgentEvent.Failed`, or crash after retries | yes |
| `running` | `interrupted` | fiber interrupted | yes, in `onExit` |
| `interrupted` | `running` | `resume` | yes |
| `failed` | `running` | `resume --retry-failed` | yes |

Reconciliation at the start of `resume`, per task. `dir` is the directory recorded in `worktrees`. `branch` is the recorded branch.

| Recorded status | `dir` exists | `branch` exists | Action |
|---|---|---|---|
| `pending` | no | no | nothing |
| `pending` | yes or no | yes | crash between recording the intent and creating. Remove whatever exists, keep `pending`. |
| `running` | yes | yes | crash during the task. Kill `pgid` if alive. Becomes `interrupted`. |
| `running` | no | yes or no | worktree lost. Becomes `failed` with `reason: "worktree missing"`. |
| `interrupted` | yes | yes | resumes in the same worktree. |
| `interrupted` | no | yes | recreates the worktree from the branch. |
| `succeeded` or `failed` | yes | yes | release did not finish. Tries to remove the directory without `--force`. Warns if it fails. |

Run state on disk. One file. `version` allows future migration.

```ts
export class RunState extends Schema.Class<RunState>("agentrun/RunState")({
	version: Schema.Literal(1),
	runId: Schema.String,
	repoRoot: Schema.String,
	base: Schema.String,
	baseSha: Schema.String,
	concurrency: Schema.Int,
	tasks: Schema.Array(Task),
	status: Schema.Record(TaskId, TaskStatus),
	worktrees: Schema.Record(TaskId, Schema.Struct({
		path: Schema.String,
		branch: Schema.String,
		pgid: Schema.optional(Schema.Int),
	})),
}) {}
```

Normalized agent events. This is the contract between adapters and the runner.

```ts
export const AgentEvent = Schema.Union([
	Schema.TaggedStruct("Started", { sessionId: Schema.optional(Schema.String) }),
	Schema.TaggedStruct("Text", { text: Schema.String }),
	Schema.TaggedStruct("ToolCall", { id: Schema.String, name: Schema.String, input: Schema.Unknown }),
	Schema.TaggedStruct("ToolResult", { id: Schema.String, isError: Schema.Boolean, summary: Schema.String }),
	Schema.TaggedStruct("Usage", { inputTokens: Schema.Int, outputTokens: Schema.Int, costUsd: Schema.optional(Schema.Finite) }),
	Schema.TaggedStruct("Retry", { attempt: Schema.Int, reason: Schema.String }),
	Schema.TaggedStruct("Completed", { result: Schema.String, costUsd: Schema.optional(Schema.Finite), turns: Schema.optional(Schema.Int) }),
	Schema.TaggedStruct("Failed", { reason: Schema.String }),
])
```

Stream rules:

- Starts with `Started`. Ends with exactly one `Completed` or `Failed`. After that the stream closes.
- `Text` carries the final text of a message, not deltas.
- `Usage` is an increment per model response. The runner sums them. When the provider reports a total at the end, `Completed` carries that total and it takes precedence over the sum.
- A provider event with no mapping is dropped, with a log at `debug`.
- A malformed JSON line is an `AgentProtocolError`, not a defect.

Agent input and capabilities.

```ts
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
```

Errors. All are `Data.TaggedError`. Anything outside this list is a defect and goes up with `Effect.orDie`.

| Error | Fields | Transient |
|---|---|---|
| `TaskFileError` | `path`, `line`, `message` | no |
| `UnsupportedOption` | `taskId`, `agent`, `option` | no |
| `GitError` | `command`, `exitCode`, `stderr` | no |
| `AgentSpawnError` | `agent`, `cause` | yes |
| `AgentCrashed` | `agent`, `exitCode`, `lastEvent` | yes |
| `AgentProtocolError` | `agent`, `line`, `issue` | no |
| `AgentTaskFailed` | `agent`, `reason` | no |
| `AgentStalled` | `agent`, `idleFor` | no |
| `AgentTimedOut` | `agent`, `after` | no |
| `StateCorrupted` | `path`, `issue` | no |
| `SetupError` | `taskId`, `command`, `exitCode`, `stderr` | no |
| `RunLocked` | `path`, `pid` | no |

Two derived groupings. `TaskError` is what `runTask` catches and converts to status `failed`. `RunnerError` is what escapes `Runner.run`.

```ts
export type TaskError =
	| GitError | SetupError | AgentSpawnError | AgentCrashed | AgentProtocolError
	| AgentTaskFailed | AgentStalled | AgentTimedOut

export type RunnerError = RunLocked | StateCorrupted | GitError | PlatformError
```

`GitError` appears in both. In `runTask` it comes from the `acquire` of a task. In `Runner.run` it comes from the `reconcile` at the start of the run.

## B4. Services and layers

Exact shape in v4. `Context.Service`, not `Context.Tag` or `Effect.Service`.

```ts
import { Context, Effect, Layer, Scope, Stream } from "effect"

export interface AgentAdapter {
	readonly id: AgentId
	readonly capabilities: AgentCapabilities
	readonly run: (input: AgentInput) => Stream.Stream<AgentEvent, AgentError, Scope.Scope>
}

export class Agents extends Context.Service<Agents, {
	readonly get: (id: AgentId) => AgentAdapter
}>()("agentrun/Agents") {}

export interface Worktree {
	readonly taskId: TaskId
	readonly path: string
	readonly branch: string
}

export class Worktrees extends Context.Service<Worktrees, {
	readonly acquire: (task: Task, base: string) => Effect.Effect<Worktree, GitError, Scope.Scope>
	readonly reconcile: (state: RunState) => Effect.Effect<ReadonlyArray<TaskId>, GitError>
	readonly diff: (worktree: Worktree, base: string) => Effect.Effect<string, GitError>
}>()("agentrun/Worktrees") {}

export class StateStore extends Context.Service<StateStore, {
	readonly load: (runId: string) => Effect.Effect<RunState, StateCorrupted | NotFound>
	readonly save: (state: RunState) => Effect.Effect<void, PlatformError>
	readonly latest: Effect.Effect<Option.Option<string>>
}>()("agentrun/StateStore") {}

export class Runner extends Context.Service<Runner, {
	readonly run: (state: RunState) => Effect.Effect<RunState, RunnerError>
	readonly events: Stream.Stream<RunEvent>
}>()("agentrun/Runner") {}

export class RunLock extends Context.Service<RunLock, {
	readonly acquire: (repoRoot: string) => Effect.Effect<void, RunLocked | PlatformError, Scope.Scope>
}>()("agentrun/RunLock") {}
```

Implementation rules:

- `Agents.layer` builds each adapter inside `make`, reading `ChildProcessSpawner` and whatever else it needs with `yield*`. The adapter keeps the dependencies in its closure. This is the constructor pattern, not an improper capture.
- `Worktrees.acquire` uses `Effect.acquireRelease`. The release receives the `Exit` and applies D8. Internally, `Semaphore.make(1)` and `sem.withPermits(1)` around each git command that touches the shared `.git`.
- `Runner.run` acquires `RunLock` first, resolves `baseSha` if it does not exist yet, runs `Worktrees.reconcile`, and then does `Effect.forEach(tasks, runTask, { concurrency: "unbounded" })` and lets the layer `Semaphore` set the limit. Interrupting the parent fiber interrupts all children.
- Each `runTask` is an `Effect.fn("Runner.runTask")` with this order. Transition to `running` with `path` and `branch` already recorded (D19). `Effect.scoped` with `Worktrees.acquire`. The `setup` command through `ChildProcessSpawner` (D16). `Agents.get(task.agent).run`, consumed until the final event. Commit by the runner, `diff.patch`, and the task report (D18). `Effect.onExit` that persists the final transition. Every `TaskError` is caught inside `runTask` and becomes status `failed` (D17).
- The `RunState` lives in a `SynchronizedRef` in the `Runner` layer. `StateStore.save` is only called inside `SynchronizedRef.updateEffect`. No other code writes state.
- The release of `Worktrees.acquire` removes the worktree without `--force`. A dirty worktree is never removed. The D18 commit is what leaves it clean.
- The report shows cost only when `capabilities.costReporting` is true. Otherwise the column shows `n/a`.
- `Runner.events` is a `PubSub` exposed as `Stream.fromPubSub`. The panel subscribes. The `events.jsonl` log subscribes.
- `Effect.timeout` does not wrap the whole run. The stall timeout operates on the event stream. The absolute ceiling is an `Effect.timeoutOrElse` around the task, which fails with `AgentTimedOut`.
- Retry wraps the adapter's `run`, only for the errors marked as transient in B3.
- No `Effect.runPromise` inside the core. Only `NodeRuntime.runMain` in the CLI.
- `Live.layer` composes everything on top of `NodeServices.layer`. `Test.layer` swaps `Agents` for fake adapters and `StateStore` for memory.

## B5. Event mapping per provider

This table is the heart of multi-provider support. A new adapter fills in one column.

| `AgentEvent` | Claude Code (SDK `SDKMessage`) | Pi (`--mode json` or `session.subscribe`) | Codex (roadmap, `codex exec --json`) |
|---|---|---|---|
| `Started` | `type: "system", subtype: "init"`, `session_id` | `type: "session"` record (json mode only), `id` | `thread.started` |
| `Text` | `type: "assistant"`, `text` blocks from `message.content` | `message_end` with `message.role === "assistant"`, assembled text | `item.completed` with `item.type === "agent_message"` |
| `ToolCall` | `tool_use` block in `assistant` (`id`, `name`, `input`) | `tool_execution_start` (`toolCallId`, `toolName`, `args`) | `item.started` for `command_execution`, `file_change`, `mcp_tool_call` |
| `ToolResult` | `type: "user"` with `tool_use_result` | `tool_execution_end` (`toolCallId`, `result`, `isError`) | `item.completed` of the same types |
| `Usage` | `usage` field in `assistant` | `message_update.usage` (per assistant response, `cost.total`) | `turn.completed.usage` |
| `Retry` | `type: "system", subtype: "api_retry"` (`attempt`, `error`) | `auto_retry_start` | not documented |
| `Completed` | `type: "result"`, `is_error: false` (`result`, `total_cost_usd`, `num_turns`) | `agent_settled`, when no `auto_retry_end` with `success: false` and no `error` occurred | `turn.completed` |
| `Failed` | `type: "result"`, `is_error: true` or an error `subtype` | `agent_settled`, when there was an `auto_retry_end` with `success: false` (`finalError`) or an `error` event | `turn.failed`, `error` |
| `AgentCrashed` | process ended without `result` | process ended without `agent_settled` | process ended without `turn.completed` |

Verified points that change the implementation:

- Pi in json mode exits with code 0 even when the response failed. The adapter must look at the stop reason. In print mode, an error or abort gives a non-zero exit.
- Pi emits `agent_end` and can keep working. A `message_end` with an error can be followed by `auto_retry_start`. The adapter never decides on `message_end` or on `agent_end`. It accumulates what it saw and decides `Completed` or `Failed` only on `agent_settled`.
- Pi reports `usage` per response, not per run. The adapter emits one `Usage` per `message_end` and the runner sums them.
- Pi in JSONL. Do not use Node `readline`. Split on LF with a UTF-8 decoder. `Stream.decodeText` and `Stream.splitLines` from Effect do this.
- Claude SDK. `interrupt()` only exists in streaming input mode. To stop a `query()` with a string prompt, use `abortController.abort()` and `query.close()`.

## B6. Invocation per provider

Claude Code through the SDK.

```ts
query({
	prompt: input.prompt,
	options: {
		cwd: input.cwd,
		permissionMode: "dontAsk",
		settingSources: [],
		allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
		disallowedTools: ["Bash(git worktree *)", "Bash(git checkout *)", "Bash(git switch *)", "Bash(git push *)", "AskUserQuestion"],
		maxTurns: Option.getOrUndefined(input.maxTurns),
		maxBudgetUsd: Option.getOrUndefined(input.maxBudgetUsd),
		model: Option.getOrUndefined(input.model),
		abortController,
	},
})
```

Why this combination. `dontAsk` denies everything that would ask for confirmation, without blocking. `allowedTools` with a plain name approves the whole tool. `Bash` without a scope gives a full shell inside the worktree, and that is what a coding task needs. The scoped rules in `disallowedTools` are denied in any mode. `settingSources: []` does not load `.claude/settings.json` or `CLAUDE.md` from the target repository (D13).

Wrap it in `Effect.acquireRelease` to call `abort()` and `close()` when the scope closes. Consume it with `Stream.fromAsyncIterable`.

There is no Claude adapter through the CLI in v1. One path per provider.

Pi through a subprocess. Reference command line:

```
pi --mode json "<prompt>"
```

The flags for `cwd`, model, and approval are not on the integration page. Confirm them in `packages/coding-agent/docs/cli.md` of the `earendil-works/pi` repository during spike C1 and record them here.

Pi through the SDK, if the spike approves.

```ts
const { session } = await createAgentSession({ cwd: input.cwd, sessionManager: SessionManager.inMemory() })
session.subscribe(handler)
await session.prompt(input.prompt)
```

`abort()` stops the active operation. `dispose()` in the scope release. Subscribe before you call `prompt()`. `SessionManager.inMemory()` only affects the conversation history. Discovery of settings, extensions, skills, and context files is controlled by `settingsManager`, `resourceLoader`, and `cwd`. The exact names of the options that turn discovery off are left to spike C1 (D22).

Pi through a subprocess uses `ChildProcess.make("pi", [...], { cwd, detached: true, killSignal: "SIGINT", forceKillAfter: "10 seconds" })` and the adapter kills the process group on release (D21).

## B7. Files on disk

```
~/.agentrun/
	worktrees/<repo-hash>/<run-id>/<task-id>/   worktree, removed per D8 and D18
	locks/<repo-hash>.lock                       D15
<repo>/.agentrun/
	runs/<run-id>/
		state.json                            RunState, escrita atômica
		report.md
		report.json
		tasks/<task-id>/
			events.jsonl                       todos os AgentEvent, um por linha
			diff.patch                         git diff <base>...<branch>
			stderr.log                         só para adaptadores em subprocesso
```

`<run-id>` is a compact ISO timestamp plus 4 random characters. `.agentrun/` goes into the target repository's `.gitignore` as a suggestion from `doctor`, never through an automatic write.

## B8. CLI

| Command | Does | Flags |
|---|---|---|
| `agentrun run <TASKS.md>` | creates the run, executes it, reports | `--concurrency n`, `--base ref`, `--keep-worktrees`, `--json`, `--dry-run`, `--load-project-settings` |
| `agentrun resume [run-id]` | resumes the most recent run or the given one | `--retry-failed`, same flags as `run` |
| `agentrun doctor` | checks git, binaries, minimum versions, authentication | `--json` |
| `agentrun report [run-id]` | reprints the report | `--json` |

Exit codes: 0 when all tasks `succeeded`. 1 when some task `failed`. 2 for a configuration error. 130 when interrupted by Ctrl-C with the state saved.

Ctrl-C. `NodeRuntime.runMain` converts `SIGINT` into an interruption of the main fiber. Finalizers run. A second Ctrl-C within 3 seconds forces exit without cleanup, with a warning.

## B9. Report

`report.md`:

```
# agentrun. Run 20261002T1530-k3f9

| Task | Agent | Status | Duration | Cost | Branch |
|---|---|---|---|---|---|
| fix-login | pi | succeeded | 4m12s | $0.41 | agentrun/fix-login |
| add-healthcheck | claude-code | failed | 1m03s | $0.09 | agentrun/add-healthcheck |

## fix-login
Diff: tasks/fix-login/diff.patch (3 files, +41 -7)
Result: <final agent text>

## add-healthcheck
Reason: AgentTaskFailed: tests failed after 3 attempts
```

`report.json` is the `RunState` plus, per task, `durationMs`, `costUsd`, `diffStat`, and `result`. This JSON is the output that the MCP server will return later.

## B10. Monorepo structure

```
agentrun/
	package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.js
	.github/workflows/ci.yml           lint, typecheck, test, build
	docs/
		SPEC.md                          this file
		adr/                             one A3 decision per file, when it changes
	packages/
		core/                            @agentrun/core
			src/
				index.ts
				domain/
					Task.ts  TaskStatus.ts  RunState.ts  AgentEvent.ts  RunEvent.ts  Errors.ts
				TaskFile.ts                  parse + Schema. Funções puras.
				Agents.ts                    serviço + layer
				agents/
					ClaudeCode.ts
					Pi.ts
					Jsonl.ts                   decode de linhas para adaptadores em subprocesso
				Worktrees.ts
				StateStore.ts  StateStoreMemory.ts
				RunLock.ts
				Runner.ts
				Report.ts
				Live.ts                      Layer composto
			test/
				fixtures/fake-claude.sh  fixtures/fake-pi.sh
				fixtures/claude/*.jsonl  fixtures/pi/*.jsonl   recorded from real runs
		cli/                             agentrun
			src/
				bin.ts  cli.ts
				commands/run.ts  resume.ts  doctor.ts  report.ts
				ui/Panel.ts  ui/ansi.ts
```

---

# Part C. Plan

## C1. Spikes before step 1

Each spike is a disposable script in `spikes/`, with the result recorded at the end of this file.

**Pi spike.** Run three `createAgentSession` calls with different `cwd` values in the same process, each with a prompt that creates a file in its own `cwd`. Check that each file appeared in the right directory and that `abort()` on one session does not stop the others. Measure `process.memoryUsage().rss` with the three sessions active. If it passes and the memory is acceptable, Pi uses the SDK. If it fails, Pi uses `pi --mode json`. In that case, confirm that json mode emits `usage.cost.total` and record the flags for `cwd`, model, and approval read from `cli.md`.

In the same spike, with Pi, confirm three things for D22. Which options of `DefaultResourceLoader` and `settingsManager` turn off discovery of extensions, skills, settings, and context files. Whether a built-in tool asks for approval when embedded or runs without asking. Whether an explicit `tools` list restricts the set as the spec assumes.

**Claude spike.** Run `query()` with `permissionMode: "dontAsk"` and the list from B6, with a prompt that runs `sleep 300 &` through Bash and then continues. Call `abort()` and `close()` at 10 seconds. Check that the CLI process died, that the `sleep` died with it, and that the generator ended. Record the time between `abort()` and the end. If the `sleep` survives, the Claude adapter also needs `detached: true` from the outside, through `pathToClaudeCodeExecutable` and its own spawn, and that becomes a recorded decision.

## C2. Implementation order

Each step ends with a "done when" that you can observe.

1. **Skeleton.** pnpm workspace, two packages, strict tsconfig with `@effect/language-service`, eslint with `@effect/eslint-plugin`, vitest, CI. Done when `pnpm check` passes clean in CI.
2. **Domain and parse.** Types from B3, errors, `TaskFile.parse`. Tests C3.6. Done when the `TASKS.md` from B2 decodes and each error in the list produces the expected message.
3. **Claude adapter.** `agents/ClaudeCode.ts` with the SDK. B5 mapping. Recorded fixtures. Tests C3.7. Done when a script runs a task in the current directory and prints `Completed` with cost. At this point the core already works end to end with one provider.
4. **Worktrees.** `acquireRelease`, semaphore, D8, `reconcile`. Tests C3.5. Done when two `acquire` calls in parallel in a temporary repo create two branches without a lock error.
5. **Runner with in-memory state.** Semaphore, scope per task, `onExit`, `PubSub`. Tests C3.1, C3.2. Done when three fake tasks run with limit 2 and the interruption leaves the right state.
6. **StateStore on disk, `RunLock`, and `resume`.** Atomic write, lock per repository, reconciliation. Tests C3.4 and C3.8. Done when the crash E2E passes and a second `run` in parallel fails with `RunLocked`.
7. **Pi adapter.** As the spike decides. Same fixtures and tests as step 3. Done when the same `TASKS.md` runs one task on each provider.
8. **CLI.** `effect/cli`. `run`, `resume`, `doctor`. Output as simple logs. Done when Ctrl-C in the terminal produces exit 130 and a `state.json` with `interrupted`.
9. **Panel.** ANSI, subscribes to `RunEvent`, detects TTY, restores the cursor in a finalizer. Done when the panel shows three tasks live and the no-TTY mode prints simple lines.
10. **Report.** `report.md`, `report.json`, `diff.patch`. Done when the B9 report comes out of a real run.
11. **Retry and timeouts.** D10 and D11 with `TestClock`. Tests C3.3. Done when the retry tests pass without a real `sleep`.
12. **Publication.** README with a recorded demo, ADRs, `npm publish` of both packages.

## C3. Required tests

Write the list of failures before the code of each step. Each item below is a failure that the test must detect. Core with `@effect/vitest`. Fake agents through `Test.layer`. Real processes only in `it.live`.

1. **Cancellation.** Fake agent that emits events without stopping. Three tasks, limit 2. Interrupt the run fiber. Detected failures: handle did not receive kill; worktree of an interrupted task was removed; state does not show 2 `interrupted` and 1 `pending`; some task became `succeeded`. `it.live` variant with a real `sleep 60`. The PID is still alive after the interruption.
2. **Parallelism limit.** Fake agent increments a `Ref` when it starts and decrements when it ends. Detected failure: maximum in flight greater than the limit. With `TestClock`.
3. **Retry.** `AgentCrashed` before the first `ToolCall` twice, success on the third. Detected failures: fewer than 3 attempts; delay outside the Schedule (measured with `TestClock.adjust`); `AgentCrashed` after a `ToolCall` retried; `AgentTaskFailed` retried; interruption retried.
4. **Crash and resume (E2E).** Run the real CLI as a child process with `fake-claude.sh` on the `PATH`. `SIGKILL` in the middle. Run `agentrun resume`. Detected failures: duplicate worktree; task completed twice; unreadable `state.json`; orphan branch.
5. **Worktrees.** Real git repository in a temporary directory. Detected failures: directory or branch not created; release on success left the directory; release on interruption removed the directory; release removed a dirty worktree; orphan not detected in `reconcile`; two `acquire` calls in parallel fail with a lock. Informational variant without the semaphore, only to record the observed behavior for risk 4.
5b. **Deliverable.** Fake agent creates a new file without `git add` and edits a tracked one. Detected failures: `diff.patch` without the new file; status `succeeded` before the commit; worktree removed with an uncommitted change.
5c. **Reconciliation.** For each row of the B3 table, set up the state on disk and run `reconcile`. Detected failure: action different from the table.
5d. **Process tree.** Fake agent runs `sleep 300 &` and continues. Interrupt. Detected failure: the `sleep` is still alive. Variant with `SIGKILL` on the runner and `resume`. Fails if `resume` starts another agent with the old `pgid` alive.
6. **Parse.** Title without id, duplicate id, empty body, unknown key, option not supported by the provider. Detected failure: message without `path` and `line`, or different from the snapshot.
7. **Protocol per provider.** Recorded `.jsonl` fixtures. Detected failures: unknown type brings down the stream; malformed line becomes a defect instead of `AgentProtocolError`; `is_error` does not become `Failed`; Pi `agent_end` treated as the end; stream without `Completed` or `Failed` does not become `AgentCrashed`.
8. **Lock between processes.** Two `agentrun run` commands in the same repository in parallel. Detected failures: the second does not fail with `RunLocked`; lock of a dead PID is not replaced; lock is not removed at the end of the run.
9. **Real E2E, opt-in.** `AGENTRUN_E2E_REAL=1` runs a `TASKS.md` with two tasks, one per provider, in a minimal repo. Leaves an artifact as in C4.

## C4. Done criteria for v1

- Green CI with lint, typecheck, tests C3.1 to C3.8, and build.
- E2E C3.4 and C3.9 executed, with the artifact saved in `docs/evidence/<date>/`. The artifact has the exact command, the tested branch and HEAD, `report.md`, `report.json`, and panel captures. Never include tokens or keys.
- `agentrun doctor` passes on your machine and reports the versions.
- README with a gif of the panel and the example `TASKS.md`.
- Packages published on npm under the MIT license.

## C5. Roadmap after v1

1. Codex adapter through `codex exec --json`. The B5 column is already filled in.
2. Session continuation on `resume` (Claude SDK `resume`, Codex `resumeThread`).
3. SQLite with `@effect/sql-sqlite-node@4` and a queryable event log.
4. MCP server exposing `Runner.run` and `report.json`.
5. Automatic evaluation of the result per task.

---

# Appendix. Sources verified on 2026-10-02

- `.d.ts` files downloaded from npm for `effect@4.0.0`, `@effect/platform-node@4.0.0`, and `@effect/vitest@4.0.0`.
- v4 docs: `effect.website/docs/v4/requirements-management/services`, `.../layers`, `.../concurrency/fibers`, `.../resource-management/scope`, `.../error-management/retrying`, `.../scheduling/choosing-and-combining-schedules`, `.../schema/classes`, `.../schema/error-formatters`.
- Claude Code: `code.claude.com/docs/en/cli-reference`, `.../headless`, `.../agent-sdk/typescript`, `.../agent-sdk/permissions`. SDK `@anthropic-ai/claude-agent-sdk@0.3.287`.
- Two external reviews on 2026-10-02, one by a Claude session and one by `gpt-6.1-sol` at high effort. The second one led to D18 to D22, the reconciliation table, and tests C3.5b to C3.5d.
- Pi: `github.com/earendil-works/pi`, files `packages/coding-agent/docs/sdk.md`, `json.md`, `cli-integration.md`. Package `@earendil-works/pi-coding-agent@1.0.0`.
- Codex: `learn.chatgpt.com/docs/non-interactive-mode`, `github.com/openai/codex/sdk/typescript/README.md`. Package `@openai/codex-sdk@0.160.0`.
- Lalph: `github.com/tim-smart/lalph`, `src/Worktree.ts`, `src/Workers.ts`, `src/Persistence.ts`, `src/CliAgent/claude.ts`. It uses `4.0.0-beta.94`, which is why it imports `effect/unstable/process`. In 4.0.0 the path is `effect/process`.

# Spike log

## Pi spike, 2026-10-02, partial

Script: `spikes/pi/parallel-sessions.ts`. Run with `mise exec -- node spikes/pi/parallel-sessions.ts`. Pi 1.0.0, SDK in process, default model `anthropic/claude-opus-4-8` from the local Pi settings.

Answered without a model call:

- Four in-process sessions with distinct `cwd`, `SessionManager.inMemory()`, `SettingsManager.inMemory()`, and a `DefaultResourceLoader` with every discovery option off start together and settle without blocking. Peak RSS with the four active was 151 MB.
- The discovery options are `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles` on `DefaultResourceLoaderOptions`. `agentDir` is required. `createAgentSession` takes `cwd`, `tools`, `sessionManager`, `settingsManager`, `resourceLoader`, `model`, `thinkingLevel`.
- For the subprocess path, `pi --help` confirms `--mode json`, `--print`, `--no-session`, `--no-extensions`, `--no-skills`, `--no-context-files`, `--no-prompt-templates`, `--no-themes`, `--tools`, `--exclude-tools`, `--model`, `--provider`, `--approve`, `--no-approve`. There is no `cwd` flag. The adapter sets `cwd` on spawn.
- A model failure arrives as `message_end` with `message.stopReason: "error"` and `message.errorMessage`, followed by `agent_end` and `agent_settled`. This matches the B5 mapping.
- Event sequence observed for one prompt: `agent_start`, `turn_start`, `message_start`, `message_end`, `turn_end`, `agent_end`, `agent_settled`.

Blocked on authentication: the Anthropic OAuth token stored by Pi had expired (`Refresh token expired`), so no run reached a tool call. Still open after the re-login: writes land in the right `cwd`, `abort()` on one session leaves the others running, a child `sleep` dies with the abort, and whether built-in tools prompt for approval.

## Claude spike

Pending. Deferred by decision on 2026-10-02.
