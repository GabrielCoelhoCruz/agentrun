import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const mode = process.env.FACTORY_FIXTURE_CHECK
appendFileSync(
  process.env.FACTORY_FIXTURE_CHECK_LOG,
  `${JSON.stringify({ pid: process.pid, attemptId: process.env.FACTORY_ATTEMPT_ID })}\n`,
)
if (mode === "cancel-check" || mode === "timeout") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
  writeFileSync(
    join(process.env.FACTORY_ARTIFACT_DIR, "active.json"),
    JSON.stringify({ pid: process.pid, child: child.pid }),
  )
  await new Promise(() => {})
}
if (mode === "missing-result") process.exit(0)
const artifact = join(process.env.FACTORY_ARTIFACT_DIR, "observation.txt")
writeFileSync(artifact, "The configured producer executed.\n")
if (mode === "linked-artifact") {
  const outside = join(dirname(process.env.FACTORY_ARTIFACT_DIR), "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "observation.txt"), "Outside the attempt artifact directory.\n")
  symlinkSync(outside, join(process.env.FACTORY_ARTIFACT_DIR, "linked"), "dir")
}
writeFileSync(
  process.env.FACTORY_RESULT,
  JSON.stringify({
    version: 1,
    attemptId: mode === "old-attempt" ? "previous-attempt" : process.env.FACTORY_ATTEMPT_ID,
    candidate: mode === "wrong-candidate" ? "0".repeat(40) : process.env.FACTORY_CANDIDATE,
    checkId: process.env.FACTORY_CHECK_ID,
    criteria: mode === "omitted-criterion" ? [] : [{
      id: "persisted-note",
      outcome: "pass",
      artifacts: [
        mode === "missing-artifact"
          ? "missing.txt"
          : mode === "linked-artifact"
          ? "linked/observation.txt"
          : "observation.txt",
      ],
    }],
  }),
)
