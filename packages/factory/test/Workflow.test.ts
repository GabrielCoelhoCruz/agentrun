import { execFile } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "vitest"

test("production CLI rejects invalid profiles and proves persistence after correction", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "quick",
  ], { timeout: 300000, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 3, paidProviderCalls: 0 })
}, 300000)
