# Step 9 terminal review

The CLI now shows task statuses and recent logs in an ANSI panel.
It uses a separate terminal screen and restores the cursor when the scope closes.
The core has no new terminal imports.

Each task retains at most 1000 nonempty log lines, with 4096 characters per line.
The panel redraws at most once per 100 milliseconds, plus initial and final frames.
Persistence and event subscription remain independent of redraws.
Worker stderr and CLI diagnostics use the managed output path.
JSON stdout remains parseable. Piped output uses simple lines and stderr diagnostics.

## Verified candidate

- Branch: `feat/terminal-panel`.
- Starting commit: `84e871d573f574306cc7cff4efd947329bc741f9`.
- Changes remain uncommitted for review.
- Node 24.21.0; lint, typecheck, 165 tests, both package builds and diff checks passed on macOS.
- Real PTY fixtures use explicitly injected fake providers. They do not call paid providers.
- Inspected rendered running, success, failed, interrupted, resized, resume and non-TTY states.
- Three active tasks appear together. Long Unicode titles and hostile log controls do not overwrite task rows.
- The resize case changes 80 × 24 to 32 × 12 while tasks run.
- Private evidence includes raw captures, screenshots, source hashes, exact commands, exit codes and process audits.

## Repeat

Use Node 24 as `node` before these commands. Use a new private directory for each run.

1. Create the evidence directory.

   ```sh
   export AGENTRUN_TEST_EVIDENCE=$(mktemp -d /tmp/agentrun-terminal-review.XXXXXX)
   ```

2. Run the real terminal scenarios.

   ```sh
   node node_modules/vitest/vitest.mjs run --project cli packages/cli/test/Terminal.test.ts --maxWorkers=1
   ```

3. Install the renderer inside the evidence directory.

   ```sh
   npm install --prefix "$AGENTRUN_TEST_EVIDENCE/emulator" @xterm/xterm@6.0.0 @xterm/addon-unicode-graphemes@0.4.0
   ```

4. Generate the terminal replay.

   ```sh
   node packages/cli/test/render-terminal.mjs "$AGENTRUN_TEST_EVIDENCE"
   ```

5. Serve the replay for visual review.

   ```sh
   python3 -m http.server 18769 --bind 127.0.0.1 --directory "$AGENTRUN_TEST_EVIDENCE/emulator"
   ```

6. Open `http://127.0.0.1:18769/` and inspect each terminal state.

7. Stop the server with Ctrl-C after review.

## Limits

The supported terminal needs ANSI cursor and alternate-screen controls.
Unicode clipping reserves cells conservatively; some titles end early.
A very small terminal shows fewer tasks and an overflow notice.
SIGKILL cannot run a finalizer. A second Ctrl-C restores the terminal but still skips process cleanup.
Linux must run the new PTY cases in CI. This phase does not claim paid-provider E2E or complete v1.
