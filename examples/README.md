# Run the example task

The task asks Claude Code to write `example.txt` with the text "example". It asks the provider not to run shell commands.
Worktrees and tool restrictions are not a security sandbox.

Use Node.js 24, Git, and the reviewed local installation. Set `AGENTRUN` to the absolute path of its `node_modules/.bin/agentrun` executable.
Start from the reviewed source repository root. The commands create a disposable repository outside that checkout.

1. Prepare a committed example repository.

   ```sh
   mkdir ../agentrun-example
   cp examples/TASKS.md ../agentrun-example/TASKS.md
   cd ../agentrun-example
   git init
   printf '.agentrun/\n' > .gitignore
   git add .gitignore TASKS.md
   git commit -m "docs: add example task"
   ```

2. Validate the task without a provider call.

   ```sh
   "$AGENTRUN" run TASKS.md --dry-run --json
   ```

   The dry run reports one task, concurrency 1, and the resolved base commit. It does not create a delivery patch.

3. If wanted, run the task with Claude Code.

   A provider run can incur charges. Configure provider authentication before this optional step.
   The task sets `maxTurns: 3` and `maxBudgetUsd: 0.25`. It uses a one-minute stall timeout and a two-minute task deadline.

   ```sh
   "$AGENTRUN" doctor
   "$AGENTRUN" run TASKS.md
   ```

4. After a provider run, inspect the reports.

   ```sh
   "$AGENTRUN" report
   "$AGENTRUN" report --json
   ```

A successful task keeps its delivery branch and `.agentrun/runs/<run-id>/tasks/example/diff.patch`.
The report records the branch and task result. The file belongs to the delivery branch, not the base checkout.
Reports can contain private prompts, repository paths, and diffs. Review and sanitize reports before sharing them.
