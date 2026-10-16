# Run a local project workflow

`agentrun-factory` takes a project profile and a goal. It runs implementation, project checks, restricted review, and bounded corrections.
It then asks for an explicit decision about the exact candidate. Approval permits a local export.
The package is private and is not published to npm.

## Start from a committed project

Use Node 24. The executor supports macOS and Linux. Deterministic providers prove the TypeScript and Python journeys on macOS and Linux. On 2026-10-15, one real Claude Code run also completed the TypeScript journey on macOS, for $0.26: implementation, the restart check, read-only review, approval and export.
Real-provider runs of the Python journey and on Linux remain separate work.

Build this repository with `pnpm install --frozen-lockfile` and `pnpm build`.
Run the factory binary from the target project's root. Commit the profile and its declared files before starting.

```sh
agentrun-factory start --profile factory.json --goal "Store a note and read it after restart" --id notes-001
agentrun-factory status notes-001 --json
```

The profile selects the providers. Each agent stage uses the installed `agentrun` CLI and its production worker.
Provider authentication comes from the caller's environment and provider configuration. The factory does not store credential values in the profile.

[The TypeScript example](../../examples/factory/notes-ts/factory.json) declares a complete restart journey.
Its starter server deliberately stores notes in memory. The implementation goal is to make those notes survive restart using SQLite.
The check starts the server, verifies readiness, creates a note, stops the server, restarts it, and reads the note.
It also inspects the database migration version and the stored row.

[The Python example](../../examples/factory/notes-py/factory.json) declares the same journey for a Python 3.12 standard-library server.
The engine code is the same. Only the profile, the starter `server.py`, and the check `checks/restart.py` differ.

## Configure explicit acceptance

The JSON profile has version `1`. Unknown fields, unsupported capabilities, missing inputs, and invalid references fail before agent work.
Each acceptance criterion names one declared check. The acceptance list cannot be empty.

Each check declares these fields:

- `id` identifies the producer.
- `argv` is a command and its arguments. The factory does not interpret a shell string.
  A command with `/` is relative to the candidate root and must also appear in `files`.
  A bare command name is resolved from the caller's PATH and pinned by content hash.
- `cwd` is relative to the candidate checkout.
- `files` names the committed scripts and configuration that define the trusted producer.
- `requiredEnv` lists environment variable names. Values come from the invoking environment.
- `timeoutMs` bounds the command.

Each check runs in a separate owned checkout of the exact candidate. Checks must perform their own setup and teardown.
A project script owns its services, readiness probes, migrations, credentials, and background work. It must keep child processes within the owned process tree.
Checks cannot rely on another check's uncommitted build output. Use one script when steps must share runtime state.
Declared producer files are pinned from the initial base. A candidate that changes those files cannot pass the check.
Producer paths cannot traverse symbolic links to another location. Returned artifacts must resolve inside their attempt directory.
List the producer's dependencies in `files`; the factory does not discover an arbitrary program's transitive inputs.

The factory supplies these environment variables:

| Name | Meaning |
| --- | --- |
| `FACTORY_RUN_ID` | Workflow identity |
| `FACTORY_ATTEMPT_ID` | Exact check attempt |
| `FACTORY_CHECK_ID` | Declared producer |
| `FACTORY_CANDIDATE` | Exact commit under test |
| `FACTORY_WORKSPACE` | Owned candidate checkout |
| `FACTORY_ARTIFACT_DIR` | Directory outside the disposable checkout |
| `FACTORY_RESULT` | Required JSON result file |

The script writes one outcome for each assigned criterion. Each criterion names at least one artifact relative to the artifact directory.
The factory computes artifact hashes after the command ends and owned cleanup succeeds.
A missing result, wrong identity, omitted criterion, or missing artifact cannot become a pass.

```json
{
  "version": 1,
  "attemptId": "the-supplied-attempt",
  "candidate": "the-supplied-commit",
  "checkId": "restart",
  "criteria": [
    { "id": "persisted-note", "outcome": "pass", "artifacts": ["journey.json"] }
  ]
}
```

Criterion outcomes are `pass`, `fail`, and `not-run`. A pass also requires command exit code zero and no termination signal.
A project check is a trusted producer chosen in the profile. A model's success message is not acceptance evidence.

## Inspect and decide

Status includes the stage, blocker, exact candidate, evidence, duration, reported cost, and next command.
Unknown cost is `null` in JSON and `unknown` in text. A reservation of provider budget is separate from a reported charge.

Review returns `accepted`, `revision-needed`, or `human-needed`. Findings must identify changed lines in the candidate diff.
The reviewer uses the executor's read-only tool profile. It cannot use Bash, write tools, project settings, or writable child delegation through that profile.
This tool restriction is not an operating-system sandbox.

The default limit is two automatic corrections. `limits.corrections` can change that count.
`limits.durationMs` is a deadline measured from workflow creation, including time between commands.
An approval and export can finish after that deadline; another agent or check cannot start.
A provider budget is accepted only when the selected roles support it. Unreported cost keeps its reserved amount unavailable.
A no-change correction requires a human decision. It is not reported as a successful repair.

Copy the exact request fields from `status` into the decision command:

```sh
agentrun-factory decide notes-001 --request REQUEST --candidate SHA --evidence DIGEST --expected-version VERSION --action approve
agentrun-factory export notes-001
```

The available actions are in the persisted request. Depending on the state, the request permits approval, one explicit correction, or rejection.
A repeated identical decision returns its saved result. A stale request, candidate, evidence digest, or version is refused.
A new candidate invalidates prior checks, review, and approval.
Rejection is terminal when the decision is saved. After a crash, resume, repeated start, or the same reject decision finishes owned cleanup without dispatching work.
Before manual correction replaces an incomplete agent attempt, the factory stops its recorded workers with current ownership proof. Unproved ownership refuses the decision.
Cleanup does not change the request version. An interrupted decision can be retried with the same evidence and version.

Approval confirms a reversible local action. It does not authenticate a human against another process with the same OS user.
A same-user process can alter control records. The factory grants no publication privilege and performs no push, PR creation, merge, or deployment.

## Resume and cancel

```sh
agentrun-factory resume notes-001
agentrun-factory cancel notes-001 --expected-version VERSION
agentrun-factory events notes-001 --after 0 --json
```

Resume and repeated start require the saved executor path and runtime hash. A moved installation is refused, even if its runtime bytes match.
Restore the pinned installation to continue that workflow. Resume does not select the latest run or blindly repeat interrupted provider work.
A complete delivery is validated and reused. A proved completion checkpoint can finish delivery through the executor's existing recovery path.
A reservation with missing state, missing creation proof, corrupt data, or an unknown tool outcome blocks automatic progress.
Preserve those records and follow the status guidance. Do not remove corrupt state to make a workflow appear successful.

Cancel records a request and checks current process ownership before sending signals. A cancelled attempt keeps its partial output.
A saved PID alone is not ownership. Escaped daemons and hostile processes under the same OS account are outside this contract.

The coordinator uses the executor's Git lock for check workspaces. It releases that lock before launching the executor.
A second active coordinator for the same repository is refused. Other commands can still read status or request cancellation.

## Local artifacts

State and immutable artifact bytes live under the real Git common directory, in `agentrun/factory/runs/<id>`.
The directory contains a SQLite database and owned process output. It remains outside disposable agent and check workspaces.
The sequenced facts are the source of workflow state. `events` exposes the same sequence that a later interface can consume.
No browser server is included.

Export contains the exact source archive, binary patch, pinned profile, workflow evidence, and a digest manifest.
`source.tar` is built from the approved Git tree and blob bytes. Git export attributes cannot omit files or substitute content.
It preserves tracked paths, executable modes, and symbolic link targets. Tracked submodules and non-UTF-8 paths or link targets are refused.
Source archives are limited to 64 MiB. Directory modes are 0755; archive timestamps are fixed at the Unix epoch.
Export retries verify the existing bytes. Conflicting files are preserved and refused.
These local artifacts can contain prompts, source, logs, and local paths. Inspect them before sharing.

The store uses SQLite transactions with synchronous durability. The executor state and creation receipts retain their existing power-loss limits.
Neither the store nor the executor promises exactly-once external effects. An outcome that cannot be established remains unknown.

## Reproduce the deterministic proof

Run the required project checks with `pnpm check` and `pnpm build`.
The factory tests call the production binaries and check invalid profiles, accepted delivery, correction, decision crashes, worker cleanup, and runtime relocation, concurrent cancellation, and exact source export.
The complete driver accepts an installed factory binary and a new evidence directory:

```sh
node packages/factory/scripts/factory-e2e.mjs /path/to/installed/bin.mjs /path/to/new-evidence
```

The driver uses deterministic SDK fixtures. It does not make paid provider calls.
Each scenario saves commands, output, durable state, and artifacts. The exported application repeats the restart journey from its delivered source.

The same engine also delivers a Python application. `examples/factory/notes-py` uses the Python 3.12 standard library and checks the note with `python3 -I -B checks/restart.py`.
Select the example with the fourth argument, after the scenario list:

```sh
node packages/factory/scripts/factory-e2e.mjs /path/to/installed/bin.mjs /path/to/new-evidence happy,correct notes-py
```

The installed proof runs every TypeScript journey and the Python journeys that read or change application files.

## Run a real-provider journey

`scripts/real-journey.sh` repeats the TypeScript journey with the profile's real providers. These calls cost money.
It copies an example into a new Git repository, starts the factory, approves the exact human request, and exports.
It then compares `change.patch` with `git diff`, repeats the profile check on the exported `source.tar`, and runs the same check on the starter.
The starter run must fail. The script prints the exit codes to `exits.txt` and ends with `RESULT PASS` or `RESULT FAIL`.

On macOS or Linux, with Node 24 and Python 3 on `PATH` and provider authentication in the environment:

```sh
pnpm install --frozen-lockfile && pnpm build
bash packages/factory/scripts/real-journey.sh --factory "$PWD" --out /path/to/new-output --id notes-real-001 --budget 4
```

`--example` selects another example directory, `--check` another profile check, and `--goal` another goal.
The output directory contains only public evidence: exit codes, toolchain versions, the factory commit,
start/decide/export summaries, manifest digests, the check result summary, and a report.
Each file is limited to 64 KiB. A fixed schema checks field names, verdicts, hashes, bounded numbers, and tool versions.
The wrapper captures versions and the factory commit before the provider starts. It keeps these values and exit results in parent shell memory.
Other public values come from captured factory records outside the agent workspace. The repeated check outcome comes from the wrapper exit result.
It does not copy raw tool output, goals, paths, review messages, or provider text into public files.
The script captures factory and provider stdout and stderr in temporary files under the output directory.
It redacts the exact `ANTHROPIC_API_KEY` value before saving those streams. The wrapper prints a fixed result line.
Git commands ignore system and global configuration. They disable hooks, filesystem monitors, filters, signing, automatic maintenance, external diffs, and text conversion.
Independent verification reads a fresh repository containing copied objects without candidate configuration.
It uses a private home directory and deletes the temporary repository, factory state, exports, and databases when it exits.
Provider code can write raw data inside that temporary directory while the journey runs.

The `Real provider journey` GitHub Actions workflow runs the same script on Linux. Start it by hand from the Actions tab.
It reads `ANTHROPIC_API_KEY` from the `real-provider` environment. Add a required reviewer to that environment before a paid run.
Factory processes and their provider children do not receive Actions file-command paths, runtime tokens, or upload endpoints.
Before upload, a separate step scans the final evidence and generates a fixed summary from the scanned result.
The journey step clears its current Actions summary on exit. Changes to its environment, output, or path command files fail the journey and restore their previous contents.
The scan step writes the summary from validated wrapper results. The scan blocks the key, whitespace splits, base64 at each byte offset,
URL encoding, hex, and private key fragments of 16 or more characters.
The step also rejects missing or extra files, read errors, links, nested paths, empty keys, and files over 64 KiB.
A failed scan blocks the summary and upload and fails the job.
Only the approved evidence is uploaded, including when the journey fails.
Provider transcripts, prompts, agent logs, target repositories, factory state, and databases are excluded.

### Threat model

This repository is public. The workflow log, step summary, and artifacts are public too.
The agent under test must receive `ANTHROPIC_API_KEY` and has network access.
A deliberately malicious agent can send that key over the network. Output filtering cannot prevent this.
A malicious process can also recover runner paths from ancestor processes, including through `/proc` on Linux.
The wrapper is not an operating system sandbox against another process with the same user.

The workflow protects against accidental leaks from an honest agent and its tools.
It also prevents candidate Git configuration from running programs in the trusted harness.
For the remaining malicious-agent risk, use manual `workflow_dispatch` only and add a required reviewer to the `real-provider` environment.
Use a dedicated key with a low spending cap, set the budget input, and rotate the key after a suspicious run.

After `pnpm build`, prove this boundary without paid calls:

```sh
node packages/factory/scripts/real-journey-e2e.mjs /path/to/new-fixture-proof
```

The fixture provider echoes a fake key, adds raw and encoded tool text, and attempts to write to Actions publication paths.
The proof checks the final artifact, the scrubbed child environment, and the trusted summary writer.
It then adds encoded leaks and unsafe files and checks that publication fails without printing the key.

Observed cost for notes-ts: $0.26 to $0.83 per run. These are observed values, not a limit. `--budget` sets the limit.
