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

See the repository README for setup, retry, cancellation, provider limits, and security limits. MIT license.
