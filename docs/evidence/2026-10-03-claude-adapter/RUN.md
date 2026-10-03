# Claude adapter verification

Target: `<checkout>`, branch `feat/claude-adapter`, HEAD `833d8aa06f963f9c47cedf5918f1d78065510a94`, with local changes.
The package manifest and lockfile had changes before this task. This task preserved those changes.

## Order

1. Read the specified SPEC sections, existing domain types, parser, local Effect docs, and SDK declarations.
2. Created `test/ClaudeCode.test.ts` before either implementation module. Ran `pnpm test` from the root. Exit 1: missing `../src/Agents.js`. See `red-test.txt`.
3. Created the adapter and service. Added the error union and public exports.
4. Created the run script. Built the core package for its public import. Recorded both real SDK runs.
5. Saved sanitized fixtures and passed their replay tests.
6. Ran the final checks. See `exit-codes.txt` and the separate output files.

## Commands

Run these commands from the repository root. The original check used Node 24.21.0.
The shell default used Node 22.23.2 for the first red test. The real runs and final checks use Node 24.
The script imports the built core package, so build before running it on a fresh checkout.

```sh
PRIVATE_DIR="$(mktemp -d)"
node --version # requires Node 24
pnpm build
pnpm --dir packages/core exec node scripts/run-claude.ts 'Create a file named hello.txt containing the single word hello.' "$PRIVATE_DIR/success.raw.jsonl"
pnpm --dir packages/core exec node scripts/run-claude.ts 'Create ten files named f1.txt to f10.txt, each with its own name as content, one file per tool call.' "$PRIVATE_DIR/failed.raw.jsonl" 1
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

The recording script appends to the raw output path. For a repeat run, use new raw output paths in an existing directory.
Authentication uses the SDK default account. The SDK supplies its own CLI.

## Results and files

Both real commands exited with code 0. A `Failed` event is a task outcome, so the recording script does not treat it as a script error.

- Success: `Completed`, cost USD `0.2542562`, 2 turns. See `success-events.txt`.
- Failure: raw result `is_error: true`, subtype `error_max_turns`, cost USD `0.06808199999999999`. The first attempt produced the required failure. See `failed-events.txt`.
- Final tests: `Tests 39 passed (39)`, across 2 files. The adapter has 20 tests. See `test.txt`.
- Final lint, typecheck, test, build, and check each exited with code 0.
- tsdown reports the existing TypeScript 7 experimental API warning. Build exits successfully.

Fixtures contain 5 and 23 lines. The current fixtures retain protocol records and omit irrelevant local metadata. Session and tool IDs are synthetic in the current fixtures.
The temporary directory path and its `/private` alias were replaced with `<cwd>`.
The current fixtures use synthetic session, message, and tool IDs. They retain small synthetic usage and cost values for protocol checks. Irrelevant local plugin, socket, and model metadata is removed. The original raw recordings remain private.

Raw recordings are in the private temporary directory `<private-evidence>`. The saved event output has normalized directory paths.

## Resource ownership

This task started SDK CLI runs only. It did not start an application server, database, or Compose project.
Process inventory through `ps` was denied by the execution sandbox. Existing processes were not stopped.
Both recorded script commands exited. Original process IDs remain private.
The SDK query finalizer calls `abort()` before `close()`. The cancellation test verifies that order.
Both scoped working directories were confirmed absent after their commands exited.
The completed commands left no script process running. An independent SDK child PID check was not available in this sandbox.

## API choices

`ClaudeCode` is a constant adapter bound to the real `query`, with no extra service. `Agents.layer` supplies the registry.
`Agents.get` returns `Option<AgentAdapter>` because B3 has no error for a provider that is not registered.
The public adapter retains the B4 scope requirement. Effect v4 `Stream.unwrap` manages the acquired scope internally.
`Stream.flattenIterable` supports empty decoded arrays. `Stream.flattenArray` requires a nonempty array in this Effect version.
B5 names `tool_use_result`; the SDK declares that top-level value as unknown. Correlation IDs and error flags come from `message.content` blocks of type `tool_result`.
SDK success results declare `is_error` as a boolean. Error subtypes do not require `result`; the subtype supplies the failure reason.
B6 uses explicit undefined properties. Absent options are omitted here as required by the option test.
The installed SDK is 0.3.288, versus 0.3.287 in the SPEC stack table.
Retry execution and timeouts remain later steps. The adapter only maps existing SDK retry notifications.
