# Step 8 CLI review evidence

Tested branch: `feat/cli`. Implementation commit: `fade0df2d85c14832522295045553b4752ac71ab`.
Base commit: `b1091f06e565513a52cdd12799dda9739d002d7f`.
The local tests used Node 24 and macOS kernel locks.

## Tested stack

The tests build the shipped CLI, core package, and explicit test entrypoints.
They use temporary Git repositories, branches, linked worktrees, file state,
setup shells, worker groups, and background children. Fake providers enter
through test Layers. The shipped bin handles public arguments, dry run, and doctor.
Doctor uses isolated credential locations and sends no model prompt.

## Repeat

From the repository root, use Node 24 and run these commands in sequence:

```sh
node node_modules/oxlint/bin/oxlint --config oxlint.config.js --deny-warnings .
(cd packages/core && node ../../node_modules/tsdown/dist/run.mjs src/index.ts --format esm --dts --sourcemap)
(cd packages/cli && node ../../node_modules/tsdown/dist/run.mjs src/index.ts src/bin.ts src/worker.ts --format esm --dts --sourcemap)
node node_modules/typescript/bin/tsc -b
AGENTRUN_TEST_EVIDENCE="$(mktemp -d)" node node_modules/vitest/vitest.mjs run --maxWorkers=1
```

Keep test captures outside Git. Each child saves its arguments, exit code,
stdout and stderr. The captures retain state, branches, deliverables and
ownership records. Do not run fixture builds during another CLI test run.

## Results

Lint, typecheck, core build and CLI build passed. The full suite passed
151 tests in eight files. It includes the original 140 tests and all 16
original CLI E2E cases. The expanded CLI suite has 24 E2E cases.

## Review checks

- Independent stale contenders preserve the fresh winner.
- The versioned guard keeps one inode across normal release and recovery.
- SIGKILL during PID replacement releases both lease helpers through stdin EOF.
- Unknown legacy guards and invalid PID files cause safe refusal.
- Linked worktrees share one repository lock.
- Setup errors retain task identity, command, exit code and stderr.
- Setup failure skips the provider while independent work finishes.
- Worker protocol and SDK errors retain their domain classification.
- Missing or unknown required auth makes doctor incomplete with exit 1.
- Injected runtime and lock failures also produce exit 1.
- A second Ctrl-C within three seconds forces exit 130 with a warning.
- Resume stops recorded owned processes before another worker starts.

The initial review checked util-linux flock flags against its primary manual.
Its child lifetime tests ran on macOS. The Linux follow-up below adds Linux execution.
Windows is unsupported.
The tests do not prove containment of deliberately escaped, unverified daemons.
The CLI refuses unverified ownership. No paid provider prompt ran in this review.

## Linux cleanup follow-up

Tested source commit: `fe55d485483f828ddcb08c8ffb875a533b94a1c6`, branch `feat/cli`.
[Linux CI run 37114008967](https://github.com/GabrielCoelhoCruz/agentrun/actions/runs/37114008967)
passed frozen install, lint, typecheck, 155 tests in nine files, and both builds.
The runner used Node 24.21.0 and Git 2.55.0.

The old parser rejected process-table rows with group zero. The Linux runner
reported 123 such rows. A focused test reproduces that failure while stopping
a real owned worker. Group zero is now valid in the process table; an owned
process in group zero still causes refusal.

A real child retained by its parent had process state `Zs` after exit.
`kill(pid, 0)` still succeeded. Cleanup now distinguishes exited zombies from
processes that can run. Child and lease assertions save OS state evidence.
Resume still checks that old children cannot run before the next worker starts.

Four focused checks cover group-zero rows, retained zombies, active groups with
missing or changed ownership, and a live group omitted from the process table.
Unknown process state or a failed query cannot establish exit. Active groups
still require the recorded ownership token. Signal deadlines were not increased.
The existing detached-child, setup-child, Pi Bash, lease and crash/resume cases remain.

Local macOS checks passed 155 tests, lint, typecheck and both builds on Node 24.21.0.
The final focused process checks also passed after adding sanitized diagnostics.
A scoped Debian Linux container passed the same checks on Node 24.21.0 and Git 2.51.0.
An earlier container run with Git 2.39.5 returned a different invalid-reference
exit code in one existing test. The final run used Git 2.51.0; the assertion stayed intact.

Repeat from the repository root with Node 24:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
AGENTRUN_TEST_EVIDENCE="$(mktemp -d)" pnpm test --maxWorkers=1
pnpm build
```

Retain the private child captures and `process-states.jsonl` outside Git.
The Linux zombie fixture uses Python 3 to keep the exited child unreaped until
inspection completes. CI diagnostics expose only group-zero counts and process states.
The task container was removed after saving its evidence. Existing services stayed running.
This follow-up uses explicit fake providers and makes no production model calls.
Legacy guards and active unverified groups retain safe refusal. Escaped orphan
daemons remain outside the containment guarantee.
