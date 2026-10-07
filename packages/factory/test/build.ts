import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import buildExecutor from "../../cli/test/build.js"

export default function build() {
  buildExecutor()
  const tool = createRequire(import.meta.url).resolve("tsdown/run")
  const result = spawnSync(process.execPath, [
    tool,
    "src/index.ts",
    "src/bin.ts",
    "src/supervisor.ts",
    "--format",
    "esm",
    "--dts",
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`Factory test build failed:\n${result.stdout}\n${result.stderr}`)
}
