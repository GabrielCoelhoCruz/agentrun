import { AgentProtocolError, AgentSpawnError, Pi } from "@agentrun/core"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Stream } from "effect"
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { serveWorker } from "../../src/WorkerAgents.js"
NodeRuntime.runMain(
  serveWorker((input) =>
    input.prompt.includes("protocol-error")
      ? Stream.fail(
        new AgentProtocolError({ agent: "claude-code", line: "bad wire", issue: "injected protocol error" }),
      )
      : input.prompt.includes("sdk-error")
      ? Stream.fail(new AgentSpawnError({ agent: "claude-code", cause: "injected SDK error" }))
      : Stream.fromAsyncIterable(
        (async function*() {
          const id = basename(input.cwd)
          const root = process.env.TEST_RECORDS
          if (!root) throw new Error("Missing explicit test records directory")
          const starts = join(root, `starts-${id}`)
          const prior = existsSync(starts)
          if (prior && existsSync(join(root, `child-${id}`))) {
            const pid = Number(readFileSync(join(root, `child-${id}`), "utf8"))
            let status = "gone"
            try {
              process.kill(pid, 0)
              status = "alive"
            } catch { /* absent */ }
            writeFileSync(join(root, "old-child-at-start"), status)
          }
          appendFileSync(starts, `${process.pid}\n`)
          writeFileSync(join(root, `settings-${id}`), String(input.loadProjectSettings === true))
          yield { _tag: "Started" as const }
          if (input.prompt.includes("slow-cleanup")) {
            process.on("SIGTERM", () => writeFileSync(join(root, "cleanup-started"), "ready"))
          }
          if (input.prompt.includes("worker-exit")) process.exit(3)
          if (input.prompt.includes("owned-bash") && !prior) {
            await Pi.workerBashOperations.exec(
              "sleep 300 </dev/null >/dev/null 2>&1 & echo $! > \"$TEST_RECORDS/child-task0\"",
              input.cwd,
              { onData() {} },
            )
            if (!prior) await new Promise(() => {})
          }
          if (input.prompt.includes("hold") || (input.prompt.includes("crash-once") && !prior)) {
            const sleep = spawn("sleep", ["300"], { stdio: "ignore", detached: input.prompt.includes("detached") })
            writeFileSync(join(root, `child-${id}`), String(sleep.pid))
            await new Promise(() => {})
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
          if (input.prompt.includes("fail")) yield { _tag: "Failed" as const, reason: "injected failure" }
          else {
            writeFileSync(join(input.cwd, "deliverable"), id)
            yield { _tag: "Completed" as const, result: "done" }
          }
        })(),
        (cause) => new Error(String(cause)),
      ).pipe(Stream.orDie)
  ).pipe(Effect.provide(NodeServices.layer)),
  { disableErrorReporting: true },
)
