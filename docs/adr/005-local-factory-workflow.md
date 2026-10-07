# ADR 005. A private local project workflow

## Decision

Add `@agentrun/factory` as a private package with its own `agentrun-factory` command.
The package coordinates a fixed sequence over the existing executor. It does not change the public v1 commands or defaults.
This extends the future-factory proposal without adding these features to the v1 scope in SPEC decision A2.

The sequence is implementation, project checks, restricted review, bounded correction, an explicit human decision, and local export.
The candidate is the exact delivered commit plus project, profile, report, and patch identity.
A changed candidate requires new evidence and approval. A no-change correction is a distinct outcome.

## Durable facts and external work

Use Node 24's SQLite module for ordered facts and immutable artifact bytes. Derive workflow state from validated facts.
Use short transactions with DELETE journaling and synchronous EXTRA. Commit dispatch intent before releasing an owned process.
Keep process launch and completion receipts outside disposable workspaces. Preserve unknown outcomes and corrupt records.

We compared SQLite with a single-writer JSON journal using complete, exclusively published records.
Both designs need exact executor reconciliation and process ownership checks.
SQLite removes a custom publication protocol and commits facts with their artifact bytes. It does not make external effects transactional.
A generic workflow runtime, storage interface, and alternate production backend are not needed for this sequence.

## Existing ownership remains authoritative

Use the production executor CLI with an explicit run ID saved before launch.
Use its report contract and its worktree creation receipts. Do not infer ownership from planned names.
Only proved completion or pending work without provider execution can use the executor's resume command automatically.
An incomplete reservation, unproved Git resource, or interrupted tool outcome blocks automatic repetition.

Reuse RunLock for coordinator exclusion and for the shared Git lock in separate scopes.
Release the Git lock before launching the executor. Run checks in separate Worktrees-owned checkouts.
Reuse the existing process-group ownership check for the factory's gated command supervisor.

## Evidence and authority

Project checks are explicit argv commands with pinned producer files. Each acceptance criterion names its producer and artifacts.
The coordinator requires an executed command, exact candidate identity, complete criterion results, and verified artifact hashes.
A model review is separate evidence and can veto acceptance. Its read-only tools retain ADR 004's limits.

A human request records the candidate, evidence digest, allowed actions, and expected version.
Approval permits only local export. Neither a typed commit nor this command authenticates a human against same-user processes.
External publication remains outside the factory and agent workers.

## Compatibility and limits

The existing executor packages keep their CLI behavior and unpublished status.
The factory adds no cloud service, remote scheduler, arbitrary workflow editor, borrowed workspace, or browser interface.
Its event sequence and command handler can serve a later local interface.

The TypeScript fixture proves a persisted note through a server restart. Deterministic provider evidence is distinct from real-provider verification.
Python and Linux portability evidence, live provider calls, and interface work remain separate deliveries.
The executor's existing state durability and same-user OS limits still apply.
