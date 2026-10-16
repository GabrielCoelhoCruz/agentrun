import { execFile } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "vitest"

const scenarioBudgetMs = 300000 + 60000 + 60000

test.each(["exit", "timeout"])(
  "production CLI retains process-table diagnostics during correction (%s)",
  async (mode) => {
    const parent = await mkdtemp(join(tmpdir(), "factory-correction-cause-e2e-"))
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
      fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
      join(parent, "proof"),
      `correct-executor-crash-process-table-${mode}`,
    ], { timeout: scenarioBudgetMs, maxBuffer: 1024 * 1024 })
    expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 1, paidProviderCalls: 0 })
  },
  scenarioBudgetMs + 5000,
)

test("production CLI accepts a review verdict wrapped in one JSON code fence", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-fenced-review-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "fenced-review",
  ], { timeout: scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 1, paidProviderCalls: 0 })
}, scenarioBudgetMs + 5000)

test("production CLI starts a second workflow beside the executor state", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-second-start-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "second-start",
  ], { timeout: scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 1, paidProviderCalls: 0 })
}, scenarioBudgetMs + 5000)

test("production CLI records a timeout for a check that stops slowly", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-check-timeout-stubborn-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "check-timeout-stubborn",
  ], { timeout: scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 1, paidProviderCalls: 0 })
}, scenarioBudgetMs + 5000)

test("factory driver lists the complete installed matrix without running journeys", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-journey-list-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "list"),
    "list",
  ])
  const names: string[] = JSON.parse(result.stdout).names
  expect(names).toEqual(expect.arrayContaining(["cancel-check", "foreign-process", "correct-executor-crash-lock-held"]))
  expect(new Set(names).size).toBe(names.length)
})

test("production CLI refuses correction while its executor lock is held", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-locked-correction-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "reject-crash-fault-resume,correct-executor-crash-lock-held",
  ], { timeout: 2 * scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 2, paidProviderCalls: 0 })
}, 2 * scenarioBudgetMs + 5000)

test("production CLI retains bounded redacted report subprocess failures", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-report-errors-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "report-failure-exit,report-failure-timeout",
  ], { timeout: 2 * scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 2, paidProviderCalls: 0 })
}, 2 * scenarioBudgetMs + 5000)

test("production CLI rejects invalid profiles and proves persistence after correction", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "quick",
  ], { timeout: 3 * scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 3, paidProviderCalls: 0 })
}, 3 * scenarioBudgetMs + 5000)

test("production CLI keeps rejection terminal and stops workers before correction", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-decisions-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "reject-crash-fault-resume,reject-crash-approval-decision,correct-executor-crash-normal,relocated-executor-resume",
  ], { timeout: 4 * scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 4, paidProviderCalls: 0 })
}, 4 * scenarioBudgetMs + 5000)

test("production CLI cancels a live agent and exports the exact candidate tree", async () => {
  const parent = await mkdtemp(join(tmpdir(), "factory-boundaries-e2e-"))
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../scripts/factory-e2e.mjs", import.meta.url)),
    fileURLToPath(new URL("../dist/bin.mjs", import.meta.url)),
    join(parent, "proof"),
    "cancel-agent,correct-executor-crash-reject,export-tree-base,export-tree-candidate,export-tree-metadata,export-tree-gitlink",
  ], { timeout: 6 * scenarioBudgetMs, maxBuffer: 1024 * 1024 })
  expect(JSON.parse(result.stdout)).toMatchObject({ result: "passed", scenarios: 6, paidProviderCalls: 0 })
}, 6 * scenarioBudgetMs + 5000)
