import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { freemem, loadavg } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    "main-ref": { type: "string", default: "9656354" },
    "branch-ref": { type: "string", default: "HEAD" },
    output: { type: "string" },
  },
})
if (values.output === undefined) throw new Error("Pass --output with a new directory")
const repo = fileURLToPath(new URL("../../../", import.meta.url))
const expectedNode = "v24.21.0"
if (process.version !== expectedNode) throw new Error(`Use Node ${expectedNode}; got ${process.version}`)
const output = resolve(values.output)
mkdirSync(output)
const require = createRequire(import.meta.url)
const tsdown = require.resolve("tsdown/run")
const commits = {}
const commands = []
const run = (file, args, cwd = repo) => {
  commands.push({ file, args, cwd })
  return execFileSync(file, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
}
const entries = {}
for (const label of ["main", "branch"]) {
  commits[label] = run("git", ["rev-parse", "--verify", "--end-of-options", `${values[`${label}-ref`]}^{commit}`])
    .trim()
  const snapshot = join(output, label)
  mkdirSync(snapshot)
  const archive = join(output, `${label}.tar`)
  run("git", [
    "archive",
    "--format=tar",
    `--output=${archive}`,
    commits[label],
    "--",
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "packages/core/package.json",
    "packages/core/tsconfig.json",
    "packages/core/src",
  ])
  run("tar", ["-xf", archive, "-C", snapshot])
  symlinkSync(join(repo, "node_modules"), join(snapshot, "node_modules"), "dir")
  const core = join(snapshot, "packages/core")
  symlinkSync(join(repo, "packages/core/node_modules"), join(core, "node_modules"), "dir")
  writeFileSync(
    join(output, `${label}-build.log`),
    run(process.execPath, [tsdown, "src/index.ts", "--format", "esm", "--out-dir", "dist"], core),
  )
  entries[label] = join(core, "dist/index.mjs")
}
const fixture = join(output, "repo")
mkdirSync(fixture)
const git = (...args) => run("git", args, fixture).trim()
git("init", "-q", "-b", "main")
git(
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@localhost",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "commit",
  "--allow-empty",
  "-qm",
  "base",
)
const base = git("rev-parse", "HEAD")
const target = {
  commits,
  node: process.version,
  checkout: repo,
  checkoutHead: run("git", ["rev-parse", "HEAD"]).trim(),
  dirty: run("git", ["status", "--porcelain"]),
  callsPerSample: 30,
  repetitions: 6,
  order: "main, branch, repeated six times",
  command: [process.execPath, ...process.argv.slice(1)],
  commands,
}
writeFileSync(join(output, "target.json"), JSON.stringify(target, null, 2) + "\n")
const runtimes = {}
const services = {}
const worktrees = {}
const samples = []
try {
  for (const label of ["main", "branch"]) {
    const core = await import(pathToFileURL(entries[label]).href)
    runtimes[label] = ManagedRuntime.make(
      core.Worktrees.layer({ repoRoot: fixture, home: join(output, `home-${label}`), runId: `measure-${label}` }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    )
    services[label] = await runtimes[label].runPromise(core.Worktrees)
    worktrees[label] = services[label].locate(Schema.decodeSync(core.TaskId)("measure"))
  }
  for (let repetition = 1; repetition <= 6; repetition++) {
    for (const label of ["main", "branch"]) {
      const startedAt = new Date().toISOString()
      const load = loadavg()
      const freeBytes = freemem()
      const perCallMs = await runtimes[label].runPromise(Effect.gen(function*() {
        const start = performance.now()
        for (let call = 0; call < 30; call++) yield* services[label].diff(worktrees[label], base, base)
        return (performance.now() - start) / 30
      }))
      const sample = { label, commit: commits[label], repetition, calls: 30, startedAt, load, freeBytes, perCallMs }
      samples.push(sample)
      appendFileSync(join(output, "samples.jsonl"), JSON.stringify(sample) + "\n")
      console.log(JSON.stringify(sample))
    }
  }
  const summary = {}
  for (const label of ["main", "branch"]) {
    const costs = samples.filter((sample) => sample.label === label).map((sample) => sample.perCallMs).toSorted((
      a,
      b,
    ) => a - b)
    summary[label] = {
      commit: commits[label],
      samples: costs.length,
      min: costs[0],
      median: (costs[2] + costs[3]) / 2,
      max: costs[5],
    }
  }
  writeFileSync(join(output, "result.json"), JSON.stringify({ target, samples, summary }, null, 2) + "\n")
  console.log(JSON.stringify(summary))
} finally {
  for (const label of ["branch", "main"]) if (runtimes[label] !== undefined) await runtimes[label].dispose()
}
