# ADR 001: Prove process ownership before cleanup

Status: accepted. Date: 2026-10-03. Updates SPEC D8, D15, D20, and D21.

A PID can be reused after a crash. Killing a saved PID without further checks can stop another process. The CLI records a random token and process group before starting provider work. Git commands have separate ownership journals. Resume verifies the leader and descendants before cleanup and refuses unproved ownership.

Repository claims use a kernel lease through macOS lockf or Linux flock. A permanent marker coordinates reclaim. This keeps competing processes from replacing a stale claim at the same time.

Cleanup has bounded process queries and signal escalation. Deliberately escaped daemons remain outside the supported guarantee. Direct core SDK adapters do not provide the CLI worker boundary. Windows is unsupported.

Task branches use only the last four run ID characters. A collision causes Git refusal; the suffix does not guarantee global uniqueness. Failed tasks that used tools retain their worktrees.
