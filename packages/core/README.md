# @agentrun/core

Effect v4 services for running Claude Code and Pi in Git worktrees. Requires Node 24, Git, and macOS `lockf` or Linux `flock`. Candidate version: 0.1.0. Registry publication and namespace ownership are pending.

Install both reviewed local tarballs as described in the repository README. The package exports ESM and TypeScript declarations from `@agentrun/core`.

## Parse tasks

```ts
import { Agents, TaskFile } from "@agentrun/core"
import { Effect, Option } from "effect"

const parse = Effect.gen(function*() {
  const agents = yield* Agents
  const claude = Option.getOrThrow(agents.get("claude-code"))
  const pi = Option.getOrThrow(agents.get("pi"))
  return yield* TaskFile.parse({
    path: "TASKS.md",
    content: "## example: Example\nWrite example.txt with the text example.\n",
    capabilities: { "claude-code": claude.capabilities, pi: pi.capabilities },
  })
}).pipe(Effect.provide(Agents.layer))
```

This example is checked against the installed package. It parses input without invoking providers.

`Task.tools` and `AgentInput.tools` accept the optional `"read-only"` profile.
An adapter declares support with `AgentCapabilities.readOnlyTools: true`.
The parser rejects an unsupported request. The runner also checks saved tasks before work.
An omitted field keeps the default tools. Read-only tasks reject setup and project settings.
Use the CLI for exclusive initial run reservation and the production worker boundary.

## Services and layers

| Service | Supported operations | Layer |
| --- | --- | --- |
| `Agents` | `get(id)` returns `Option<AgentAdapter>` | `Agents.layer`, or an explicit `Layer.succeed` for tests |
| `TaskFile` | `parse({path, content, capabilities})` | Pure Effect operation |
| `Runner` | `run(state)`, `subscribe`, `events` | `Runner.layer({concurrency, retryFailed?, setupInAgent?, loadProjectSettings?})` |
| `StateStore` | `load(runId)`, `save(state)`, `latest` | `layerFile({repoRoot})` or `layerMemory` |
| `Worktrees` | `locate`, scoped `acquire`, `snapshot`, `publish`, `commit`, byte `diff`, `reconcile`, process recovery | `Worktrees.layer({repoRoot, runId, home, keepWorktrees?})` |
| `RunLock` | Scoped `acquire(repoRoot)` | `RunLock.layer({home})` |
| `Report` | Events, byte patches, `save(state)`, `load(repoRoot, runId)` | `Report.layer` |

Compose services with `Layer.mergeAll` and `Layer.provide`. `Runner.layer` requires the other services plus filesystem, path, and process services from `NodeServices.layer` in `@effect/platform-node`. Scope the program so its finalizers run. Subscribe before starting the runner. The CLI uses isolated workers; direct core adapters run inside the caller process.

`RunState` stores optional private checkpoints in `taskReports`. `RunReport` excludes those checkpoints and process ownership tokens. It still includes prompts and local paths. Keep reports private unless sanitized. Errors use `Schema.TaggedError`, including `ReportError`.

`Worktrees.snapshot` creates an immutable commit object. Save its identity before `publish`; publication refuses to overwrite an unexpected branch change. `diff` returns `Uint8Array` and preserves binary patches. Successful duration ends before delivery writes. Atomic replacement does not promise power-loss durability through fsync.

## Ownership and upgrade limits

Direct core callers must hold `RunLock` across state and worktree operations. Use the CLI for initial run reservation.
A saved branch name is not creation authority. Existing resources require a matching creation receipt and current Git identity.
Git can create resources before a hook, checkout, LFS, timeout, or task deadline failure.
Crashes, interruptions, and receipt write failures can also leave unproved resources. Later retries preserve and refuse those resources.

Finish in-flight runs with the old build before upgrading. Retain that build, backups, and work.
Explicit and latest CLI resume refuse legacy runs without ownership records. Their reports remain readable.
Do not mix builds on the same repository or linked checkouts. Older builds ignore ownership records.
State schema version 1 alone does not establish compatibility. There is no automatic migration from saved names.

Records bind names and workspace identity, not branch commits.
External deletion, recreation, or rewriting of a branch, Git data, or receipt invalidates the provenance assumptions.
A foreign branch recreated under an owned name can enter delivery. These checks do not provide OS isolation.

Follow the repository README's [inspection procedure](https://github.com/GabrielCoelhoCruz/agentrun#inspect-incomplete-creation) before manual recovery.
Verify the exact common directory, run, workspace, ref, and dirtiness before cleanup. Preserve backups and uncertain resources.
Do not fabricate receipts or use destructive force commands.

See the repository README for setup, retry, cancellation, provider limits, and security limits. MIT license.
