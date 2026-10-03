import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url)
export default function build() {
  const tool = require.resolve("tsdown/run")
  for (
    const [cwd, args] of [
      [new URL("../../core/", import.meta.url), ["src/index.ts", "--format", "esm", "--dts"]],
      [new URL("../", import.meta.url), ["src/index.ts", "src/bin.ts", "src/worker.ts", "--format", "esm", "--dts"]],
      [new URL("../", import.meta.url), [
        "test/fixtures/entry.ts",
        "test/fixtures/fake-worker.ts",
        "test/fixtures/lock-entry.ts",
        "test/fixtures/doctor-entry.ts",
        "--format",
        "esm",
        "--out-dir",
        "test/fixtures/dist",
      ]],
    ] as const
  ) {
    const result = spawnSync(process.execPath, [tool, ...args], { cwd: fileURLToPath(cwd), encoding: "utf8" })
    if (result.status !== 0) throw new Error(`CLI test build failed:\n${result.stdout}\n${result.stderr}`)
  }
}
