# ADR 002: Save immutable delivery before publishing

Status: accepted. Date: 2026-10-03. Updates SPEC D4, D18, and D19.

A crash after provider completion must not require another provider call. The runner saves completion, creates an immutable Git commit, saves its identity, then publishes with a compare-and-swap update. An unexpected branch change causes refusal. The binary patch and its digest are saved before success.

Resume uses saved completion and delivery checkpoints. A pending event records the boundary between state replacement and event append. The runner awaits writes and preserves a corrupt artifact for inspection.

Atomic rename prevents partial replacement. It does not promise fsync durability after power loss. Legacy state can omit checkpoints and cannot recover data that was never recorded.
