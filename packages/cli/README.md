# agentrun

Run Claude Code and Pi tasks in separate Git worktrees. Each successful task keeps a branch, a binary patch, and a report. The CLI runs each provider in its own worker process.

![Deterministic terminal demo](demo.gif)

The demo uses explicit test adapters. It does not call a paid provider.

## Requirements and installation

Use Node.js 24 and Git on macOS or Linux. Repository locks require `/usr/bin/lockf` on macOS or `flock` on Linux. Configure provider authentication with the provider's own tools before running tasks. `agentrun doctor` checks the runtime, lock utility, and both provider accounts.

Version 0.1.0 is intentionally unpublished on npm. npm publication is outside the current plan. The package names are `agentrun` and `@agentrun/core`. Install both reviewed local tarballs together:

```sh
npm install ./agentrun-core-0.1.0.tgz ./agentrun-0.1.0.tgz
npx --no-install agentrun doctor
```

These commands assume that both reviewed tarballs are in the current directory. Keep the installation directory to reuse its `node_modules/.bin/agentrun` executable. Registry installation is not available for this version.

To run from a reviewed source checkout, use Node.js 24 and pnpm 10.29.3. Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/bin.mjs doctor
```

Use `node packages/cli/dist/bin.mjs` instead of `agentrun` for the commands below. From another repository, use the absolute path to that built file.

## Run a task

Use a disposable Git repository first. Commit the base files. Add `.agentrun/` to `.gitignore` to keep private run data out of commits. Create `TASKS.md`:

```markdown
---
base: HEAD
concurrency: 1
stallTimeout: 1 minute
maxDuration: 2 minutes
---
## example: Write a small example
agent: claude-code
maxTurns: 3
maxBudgetUsd: 0.25

Write example.txt with the text "example". Do not run shell commands.
```

```sh
agentrun run TASKS.md --dry-run --json
agentrun run TASKS.md
agentrun report
agentrun report --json
agentrun resume
agentrun resume --retry-failed
```

A dry run validates tasks and resolves the Git base without invoking providers. For Pi, set `agent: pi` and `model: provider/modelId`. Pi rejects `maxTurns` and `maxBudgetUsd`. Choose a model available in your own Pi account.

`run --json` emits one JSON event per line. `report --json` emits one JSON report. Reports contain task prompts, result text, repository paths, and diffs. Keep them private unless you review and sanitize them. Worker ownership tokens and Git process journals are excluded from report JSON.

## Choose an execution ID

Automation can save an ID before starting work:

```sh
agentrun run TASKS.md --run-id attempt-001-abcd --json
agentrun report attempt-001-abcd --json
agentrun resume attempt-001-abcd --json
```

An ID starts with a letter or digit and contains at most 128 letters, digits, underscores, or hyphens.
Starting an existing ID fails without overwriting its state. Use its exact ID to resume.
Existing branch or worktree collisions also fail. Different IDs can share the same four-character branch suffix.
A directory with missing or corrupt state requires inspection; the CLI does not replace it.
The commands without an ID retain their current defaults. Automation must not guess its attempt from the latest run.

## Restrict review tools

Add `tools: read-only` in frontmatter or under a task heading:

```markdown
## review: Review the candidate
agent: pi
tools: read-only

Inspect the supplied diff and report your findings.
```

Claude receives only Read, Glob, and Grep. Pi receives only read, grep, find, and ls.
Unknown or unsupported profiles fail before provider work. Read-only tasks cannot use setup or load project settings.
This limits model tools, not OS permissions. SDK internal writes are outside this restriction.
A successful task can produce no changes. Its result text and immutable delivery commit remain in the report.
An unchanged commit does not prove that no write occurred.

## Setup, cancellation, and recovery

Optional frontmatter `setup` runs a shell command in each worktree before provider work. Automatic retries reuse the worktree and completed setup. Recreating a worktree clears setup completion. Treat setup commands and task files as trusted input.

Provider project settings are disabled by default. `--load-project-settings` enables Claude project/local settings and Pi `.pi/settings.json`. Pi extensions, skills, templates, and context files remain disabled. This flag can enable hooks and shell configuration.

Press Ctrl-C once to save interruption and clean up owned processes. The interrupted worktree remains for `resume`. Pressing Ctrl-C again within three seconds forces exit; resume must finish recovery. Resume starts a new provider conversation, rather than continuing a saved provider session.

Transient spawn errors and crashes before the first tool call get at most three attempts, with jitter around one-second and two-second delays. Storage failures, provider task failures, protocol errors, setup errors, stall timeouts, and task deadlines do not automatically retry. Use `resume --retry-failed` only after inspecting the failure.

Defaults are two concurrent tasks, five minutes without events, and sixty minutes per task. `maxDuration` covers acquisition, setup, provider attempts, backoff, and delivery. It starts cancellation; it does not bound total exit time. Cleanup retains the task permit and can take longer. Each Git command has a separate sixty-second limit.

## Deliverables and limits

Inspect `.agentrun/runs/<run-id>/report.md`, `report.json`, and `tasks/<task-id>/diff.patch`. Successful delivery commits tracked and new files, saves exact patch bytes, and then marks success. Branches use `agentrun/<task-id>-<last-four-run-id-characters>`.

Worktrees are removed without force on ordinary completion. Dirty or interrupted worktrees remain. `--keep-worktrees` retains worktrees. Costs are provider reports, not invoice checks. Successful duration ends at provider completion; failure duration ends at the saved failure transition.

Worktrees and tool restrictions are not a security sandbox. Do not run untrusted prompts. Windows and deliberately escaped daemons are unsupported. State uses atomic replacement without an fsync guarantee for power loss. Run data includes private events and prompts. Do not commit raw captures.

Exit codes: 0 for success, 1 for failed or unfinished tasks, 2 for configuration errors, and 130 for interruption.

See the [core API](https://github.com/GabrielCoelhoCruz/agentrun/tree/main/packages/core), [SPEC](https://github.com/GabrielCoelhoCruz/agentrun/blob/main/SPEC.md), and [release evidence](https://github.com/GabrielCoelhoCruz/agentrun/tree/main/docs/evidence/release-v1). MIT license.
