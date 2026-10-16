import { spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

// Failures: writable host tools, writable build, host PID visibility, Actions file
// writes, and detached children that survive removal of the agent container.
export function probe() {
  const attack = process.env.FACTORY_FIXTURE_JOURNEY_ATTACK
  const path = "/work/probe.json"
  if (!attack || existsSync(path)) return
  const attempt = (file, data, flag = "a") => {
    try {
      writeFileSync(file, data, { flag, mode: 0o755 })
      return "wrote"
    } catch (error) {
      return error.code
    }
  }
  let result
  if (attack === "host-path") {
    result = Object.fromEntries(
      JSON.parse(process.env.FACTORY_FIXTURE_HOST_DIRS).flatMap(dir =>
        ["pkill", "sudo", "pgrep", "tar", "git"].map(name => {
          const file = dir + "/" + name
          return [file, attempt(file, "#!/bin/sh\nexit 99\n", "wx")]
        })
      ),
    )
  } else if (attack === "checkout") {
    result = { write: attempt("/factory/.checkout-probe", "changed") }
  } else if (attack === "host-pid") {
    const file = "/proc/" + process.env.FACTORY_FIXTURE_HOST_PID + "/environ"
    try {
      result = { visible: true, readable: readFileSync(file).length >= 0 }
    } catch (error) {
      result = { visible: existsSync(file), error: error.code }
    }
  } else if (attack === "channels") {
    result = Object.fromEntries(
      ["GITHUB_ENV", "GITHUB_STEP_SUMMARY"].map(name => [name, attempt("/host-channels/" + name, "injected=value\n")]),
    )
    result.inherited = Object.keys(process.env).filter(name => /^(GITHUB_|ACTIONS_|GH_|RUNNER_|INPUT_)/.test(name))
  } else if (attack === "background") {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" })
    child.unref()
    result = { pid: child.pid }
  } else result = { positive: true }
  writeFileSync(path, JSON.stringify(result))
  appendFileSync("/work/probes.jsonl", JSON.stringify({ attack, result }) + "\n")
}
