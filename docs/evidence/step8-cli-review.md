# Step 8 CLI review evidence

The candidate uses Node 24 and macOS kernel locks. The source is uncommitted.
The parent will record the final commit after review.

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

Linux uses util-linux flock. Its command flags were checked against its
primary manual; the child lifetime tests ran on macOS. Windows is unsupported.
The tests do not prove containment of deliberately escaped, unverified daemons.
The CLI refuses unverified ownership. No paid provider prompt ran in this review.
