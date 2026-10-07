# ADR 004: Explicit run identity and restricted review tools

Status: accepted. Date: 2026-10-07.
Updates SPEC B2, B5, B6, B8, D3, D19, D20, and D22.
Clarifies D4, D13, D15, D18, and D21. The factory coordinator remains outside v1 scope.

## Start once and reconcile by exact ID

A caller can record an ID before dispatch with `agentrun run TASKS.md --run-id <id>`.
IDs use `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`.
Without the flag, the CLI retains its generated ID format.
A dry run validates the ID but does not reserve it or check resource availability.

The CLI acquires the existing repository lock before reserving a run.
It checks for an existing run directory, branch, worktree, or ownership record before saving initial state.
Run reservations and branch creation receipts share `agentrun/ownership` under the real Git common directory.
Linked checkouts share that namespace. Run IDs and branch names compare without letter case on both supported hosts.
Exclusive directory creation refuses an existing run reservation, including an empty or corrupt entry.
The reservation records the exact run ID and originating checkout. State and reports retain their existing paths under that checkout.
A duplicate ID exits with code 2. A live repository owner still causes `RunLocked` and code 1.
Neither refusal starts a provider or overwrites the existing run.

Branch names retain the last four ID characters for compatibility.
Those characters do not guarantee uniqueness, including when randomly generated.
A branch or worktree collision exits with code 2 before a new run is saved.
Saving a planned branch name does not establish ownership.
After successful Git creation, Worktrees writes an exclusive receipt with the run, checkout, task, branch, and workspace identity.
That receipt reserves the branch name for its owner, even after worktree cleanup.
Acquisition, reconciliation, snapshot, publication, and cleanup validate the receipt before using existing resources.
An existing workspace must also have the expected Git common directory and branch.
Missing, invalid, foreign, or case-conflicting proof causes refusal. The CLI shows that reason without printing receipt contents.

The caller reconciles `report <id> --json` and `resume <id> --json` using its persisted ID.
The CLI checks the reloaded state identity while it holds the repository lock.
The no-argument commands keep their existing latest-run behavior for interactive use.
A coordinator must not use those defaults to infer which attempt it dispatched.

Recovery has these boundaries:

- An absent run directory and absent common reservation permit a new dispatch. Lock and collision checks still apply.
- An existing valid state and matching reservation belong to `resume <id>`, even if every task is pending.
- A live owner blocks another execution. A report can still describe completed work.
- A reservation without valid state blocks automatic dispatch and resume. Preserve it for inspection and use a different ID for new work.
- Git can create a branch or workspace before a failed `post-checkout` hook, checkout or LFS error, Git timeout, or task deadline.
  A crash, interruption, or receipt write failure can also leave resources without valid proof.
  The CLI preserves unproved resources and refuses reuse or cleanup on later retries. Fixing the original failure does not remove this refusal.
- Legacy runs without a common reservation cannot resume automatically. Legacy resources without creation receipts cannot be reused or cleaned up automatically.
- Legacy reports remain readable. These refusals do not delete, move, reset, or rewrite the existing resources.
- A saved completion or delivery uses existing recovery checkpoints without repeating completed provider work.
- Interrupted provider work can restart a conversation under the existing v1 resume rules. This is not exactly-once provider execution.

The initial run reservation precedes state storage. A crash can leave only that reservation.
The creation receipt follows Git creation. A missing or partially written receipt cannot authorize resource use.
No migration infers ownership from a saved name. Current-build owned clean, dirty, and interrupted worktrees keep their lifecycle.
The existing v1 hanging-acquisition test now expects retention and refusal of unproved partial workspaces, instead of clean partial cleanup.
Transient post-creation failures therefore require manual inspection, not guaranteed automatic retry.

Before upgrading, finish in-flight runs with the old build. Retain the old build, backups, and work.
Both explicit and latest resume refuse legacy runs without ownership records. Reports remain readable.
Do not mix old and new builds on one repository or its linked checkouts. Older builds ignore the ownership records.
The state schema remains version 1. That version alone does not establish compatibility.
There is no automatic migration or downgrade procedure after both versions have touched the repository.

The README's [inspection procedure](../../README.md#inspect-incomplete-creation) identifies incomplete ownership and safe manual recovery.
Cleanup requires the exact common directory, run, workspace, ref, and dirtiness checks, preserved backups, and evidence of creation.
Uncertain resources remain intact. Recovery must not fabricate receipts or use destructive force commands.

The receipts prevent accidental reuse between cooperating runs. They bind names and workspace identity, not branch commits.
External deletion, recreation, or rewriting of a branch, Git data, or receipt invalidates the provenance assumptions.
A foreign branch recreated under an owned name can be accepted and contribute unrelated commits to delivery.
The receipt mechanism is not OS isolation and does not protect against another process with the same permissions.
Exclusive reservation and atomic state replacement prevent concurrent overwrite and partial replacement of state.
They retain the existing lack of an fsync guarantee after power loss.
A separate reservation API would add another lifecycle without a current requirement, so it is not introduced.
`StateStore.save` remains an update operation. Callers using core services directly must own their state and repository lock.

## Request a restricted reviewer

The optional task field `tools: read-only` works in frontmatter and per-task overrides.
Its absence preserves the existing tool lists and adapter options.
`AgentInput.tools` carries the profile through the runner and production worker protocol.
`AgentCapabilities.readOnlyTools` must be `true`; an omitted or false capability means unsupported.
Parsing rejects unknown profiles and unsupported providers. The runner also checks saved and directly constructed tasks before work.

Claude exposes only `Read`, `Glob`, and `Grep` through the SDK `tools` option.
`allowedTools` grants those tools permission; it does not define tool availability.
The profile denies shell, editing, and delegation tools and disables additional MCP configuration.
Pi exposes only `read`, `grep`, `find`, and `ls`, without the worker's custom Bash tool.

Read-only tasks reject `setup` and `--load-project-settings` before execution.
Those options can run code outside the model's tool list.
Existing unrestricted tasks retain their opt-in settings behavior.

This profile restricts tools available to the model. It is not OS isolation or a filesystem sandbox.
SDK internals can still write session or configuration data. Read tools can access files allowed by the host account.
An unchanged final commit is useful integrity evidence, not proof that no write occurred.
Deterministic tests verify adapter configuration, worker transport, and installed Pi tool filtering.
Live provider enforcement requires separate provider integration evidence.

## Reuse the immutable delivery report

`RunReport` remains version 1. It already contains `baseSha`, `deliveryCommit`, `patchSha256`, and the provider's result text.
A coordinator can validate a structured review encoded in `result` against its own schema.
The executor does not interpret a review verdict as acceptance.
No second result envelope or coordinator-specific outcome is added.
Legacy reports can omit delivery fields. Missing identity or required result data blocks coordinator acceptance, without making the legacy report unreadable.

A no-change task remains a successful executor result with an empty patch and an existing commit.
Commit equality shows identity reuse. An empty patch shows no net file changes, even when the commit differs.
A coordinator must not treat that success as proof that a correction repaired a failed check.
It must decide whether to rerun acceptance or request an operator decision.

Before integrating a candidate, the coordinator checks that `baseSha` is an ancestor of the exact `deliveryCommit`.
It verifies the patch digest and applies its own expected write policy.
The mutable branch tip is not the candidate identity.
These are future coordination requirements, not new global rejection rules for existing v1 tasks.

npm remains unpublished. This change adds no factory package, project profile, scheduler, or publication action.
