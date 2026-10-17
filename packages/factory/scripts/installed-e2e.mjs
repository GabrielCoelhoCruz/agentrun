import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { availableParallelism } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("../../../", import.meta.url))
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2))
const read = (file) => JSON.parse(readFileSync(file, "utf8"))
const inside = (root, file) => {
  const path = relative(root, file)
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path)
}

// The Python example repeats every journey that reads or changes application files.
// Engine-only journeys (crashes, locks, cancellation) do not depend on the example.
export const pythonJourneys = [
  "invalid",
  "happy",
  "correct",
  "relative-command",
  "review-revision",
  "export-tree-base",
  "export-tree-candidate",
  "changed-check",
  "linked-checks",
]

export const verifyHashes = (files) => {
  assert.ok(Object.keys(files).length > 0, "Missing package hashes")
  for (const [file, expected] of Object.entries(files)) {
    assert.equal(hash(file), expected, `Package hash changed: ${file}`)
  }
}

export const verifyBindings = (consumer, modules, cores) => {
  assert.ok(modules.length > 0 && cores.length > 0, "Missing module bindings")
  for (const file of [...modules, ...cores]) {
    assert.ok(inside(consumer, file), `Module resolves outside consumer: ${file}`)
  }
  assert.equal(new Set(cores).size, 1, "Installed modules use different core instances")
}

export const verifyJourneys = (outcomes, required) => {
  assert.equal(outcomes.length, required.length, "Incomplete or unexpected installed journeys")
  assert.equal(new Set(outcomes.map((entry) => entry.name)).size, outcomes.length, "Duplicate installed journeys")
  assert.ok(outcomes.every((entry) => entry.outcome === "pass"), "Failed installed journey")
  for (const name of required) {
    assert.ok(outcomes.some((entry) => entry.name === name), `Missing installed journey: ${name}`)
  }
}

// Pin dependency edges so packing cannot silently select a different tested runtime graph.
export const lockedDependencyOverrides = (snapshots) => {
  const overrides = {}
  for (const [snapshot, entry] of Object.entries(snapshots)) {
    const parent = snapshot.split("(")[0]
    for (const [name, resolved] of Object.entries({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const selector = `${parent}>${name}`
      const version = resolved.split("(")[0]
      assert.ok(
        overrides[selector] === undefined || overrides[selector] === version,
        `Conflicting locked dependency: ${selector}`,
      )
      overrides[selector] = version
    }
  }
  return overrides
}

const saveReceipt = (evidence, name, executable, argv, cwd, started, result) => {
  save(join(evidence, `${name}.json`), {
    executable,
    argv,
    cwd,
    started,
    ended: new Date().toISOString(),
    pid: result.pid,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error === undefined ? null : { code: result.error.code, message: result.error.message },
  })
  assert.equal(result.status, 0, `Command failed: ${name}; inspect saved receipt`)
  return result.stdout
}

export const runCommand = (evidence, name, executable, argv, cwd, timeout = 900000, env = process.env) => {
  const started = new Date().toISOString()
  const result = spawnSync(executable, argv, { cwd, env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 })
  return saveReceipt(evidence, name, executable, argv, cwd, started, result)
}

// Issue #48 escaped the locked proof. Resolve registry dependencies without lock-derived overrides.
export const proveFreshResolve = (evidence, dependencies) => {
  const started = performance.now()
  const consumer = join(evidence, "fresh-consumer")
  const home = join(evidence, "fresh-home")
  const cache = join(evidence, "fresh-cache")
  for (const directory of [consumer, home, cache]) mkdirSync(directory)
  save(join(consumer, "package.json"), {
    name: "factory-fresh-resolve-proof",
    packageManager: read(join(source, "package.json")).packageManager,
    private: true,
    type: "module",
    dependencies,
    // Only workspace packages use overrides; their registry dependencies resolve freely.
    pnpm: { overrides: dependencies },
  })
  assert.equal(existsSync(join(consumer, "pnpm-lock.yaml")), false)
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: cache, npm_config_cache: join(cache, "npm") }
  const run = (name, executable, argv) => runCommand(evidence, name, executable, argv, consumer, 900000, env)
  run("fresh-package-manager", "pnpm", ["--version"])
  run("fresh-install", "pnpm", ["install", "--ignore-scripts", "--store-dir", join(cache, "pnpm")])
  run("fresh-dependencies", "pnpm", ["list", "--depth", "Infinity", "--json"])
  const output = run("fresh-import", process.execPath, [
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';
     const core = await import('@agentrun/core');
     const cli = await import('agentrun');
     const factory = await import('@agentrun/factory');
     assert.equal(core.version, '0.1.0');
     assert.equal(cli.version, '0.1.0');
     assert.equal(typeof core.Pi.adapter.run, 'function');
     assert.equal(typeof factory.handle, 'function');
     console.log('Packed package imports passed');`,
  ])
  assert.equal(output.trim(), "Packed package imports passed")
  for (
    const [name, file, expected] of [
      ["cli", "agentrun", "agentrun"],
      ["factory", "@agentrun/factory", "agentrun-factory"],
    ]
  ) {
    const help = run(`fresh-${name}-start`, process.execPath, [
      join(consumer, "node_modules", file, "dist/bin.mjs"),
      "--help",
    ])
    assert.ok(help.includes(expected), `Missing ${expected} help`)
  }
  const seconds = (performance.now() - started) / 1000
  save(join(evidence, "fresh-summary.json"), { result: "passed", seconds, paidProviderCalls: 0 })
  console.log(`Fresh dependency resolve, imports and command startup passed in ${seconds.toFixed(1)}s`)
}

const runCommandAsync = (evidence, { name, executable, argv, cwd, timeout = 900000 }) =>
  new Promise((done) => {
    const started = new Date().toISOString()
    const child = spawn(executable, argv, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGTERM" })
    let stdout = ""
    let stderr = ""
    let error
    child.stdout.on("data", (data) => {
      stdout += String(data)
    })
    child.stderr.on("data", (data) => {
      stderr += String(data)
    })
    child.on("error", (cause) => {
      error = cause
    })
    child.on("close", (status, signal) => {
      done(() =>
        saveReceipt(evidence, name, executable, argv, cwd, started, {
          pid: child.pid,
          status,
          signal,
          stdout,
          stderr,
          error,
        })
      )
    })
  })

// Each journey owns its directory, HOME and TMPDIR, so journeys run as separate driver processes.
// After the first failure no queued command starts, and the proof fails only after running ones settle.
export const runConcurrently = async (evidence, commands, limit) => {
  const outputs = []
  const failures = []
  let next = 0
  const worker = async () => {
    while (failures.length === 0 && next < commands.length) {
      const index = next++
      const finish = await runCommandAsync(evidence, commands[index])
      try {
        outputs[index] = finish()
      } catch (error) {
        failures.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, commands.length) }, worker))
  if (failures.length > 0) throw failures[0]
  return outputs
}

export const mergeJourneyResults = (parts) => {
  assert.ok(parts.length > 0, "Missing installed journey results")
  const [{ cli, cliSha256 }] = parts
  for (const part of parts) {
    assert.equal(part.cli, cli, "Installed journeys used different CLI paths")
    assert.equal(part.cliSha256, cliSha256, "Installed journeys used different CLI bytes")
    assert.equal(part.paidProviderCalls, 0, "Installed journey made paid provider calls")
  }
  return { cli, cliSha256, paidProviderCalls: 0, outcomes: parts.flatMap((part) => part.outcomes) }
}

// On pull_request the checkout is a merge commit, so the tested commit and the pull request head differ.
export const candidateIdentity = ({ head, parents, pullRequestHead, pullRequestBase }) => {
  if (pullRequestHead === undefined) return { candidate: { head, parents }, pullRequest: null }
  assert.ok(
    pullRequestHead === head || parents.includes(pullRequestHead),
    `Pull request head ${pullRequestHead} is neither the tested commit nor its parent`,
  )
  return { candidate: { head, parents }, pullRequest: { head: pullRequestHead, base: pullRequestBase ?? null } }
}

const distFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? distFiles(file) : [file]
  })

const main = async (directory, selected = "all") => {
  const evidence = resolve(directory)
  mkdirSync(evidence, { recursive: false })
  assert.ok(!inside(source, evidence), "Installed evidence must be outside the checkout")
  const git = (name, ...argv) => runCommand(evidence, name, "git", argv, source).trim()
  const head = git("source-head", "rev-parse", "HEAD")
  const branch = git("source-branch", "branch", "--show-current")
  const parents = git("source-parents", "show", "-s", "--format=%P", "HEAD").split(" ")
  const { candidate, pullRequest } = candidateIdentity({
    head,
    parents,
    pullRequestHead: process.env.AGENTRUN_PULL_REQUEST_HEAD || undefined,
    pullRequestBase: process.env.AGENTRUN_PULL_REQUEST_BASE || undefined,
  })
  assert.equal(git("source-status", "status", "--porcelain"), "", "Source checkout is dirty")
  const tracked = runCommand(evidence, "source-files", "git", ["ls-files", "-z"], source).split("\0").filter(Boolean)
  const sourceHashes = Object.fromEntries(tracked.map((file) => [join(source, file), hash(join(source, file))]))
  save(join(evidence, "source.json"), {
    head,
    branch,
    parents,
    candidate,
    pullRequest,
    node: process.version,
    platform: process.platform,
    files: sourceHashes,
  })

  const tarballs = join(evidence, "tarballs")
  const consumer = join(evidence, "consumer")
  mkdirSync(tarballs)
  mkdirSync(consumer)
  const packages = ["core", "cli", "factory"].map((directory) => ({
    directory,
    manifest: read(join(source, "packages", directory, "package.json")),
  }))
  const dependencies = {}
  const { parse } = createRequire(join(source, "packages/core/package.json"))("yaml")
  const lock = parse(readFileSync(join(source, "pnpm-lock.yaml"), "utf8"))
  const overrides = lockedDependencyOverrides(lock.snapshots)
  for (const { directory, manifest } of packages) {
    runCommand(
      evidence,
      `pack-${directory}`,
      "pnpm",
      ["pack", "--pack-destination", tarballs],
      join(source, "packages", directory),
    )
    const name = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`
    dependencies[manifest.name] = `file:../tarballs/${name}`
    overrides[manifest.name] = dependencies[manifest.name]
    for (const name of Object.keys(manifest.dependencies)) {
      const version = lock.importers[`packages/${directory}`].dependencies[name].version
      if (!version.startsWith("link:")) overrides[name] = version.split("(")[0]
    }
  }
  proveFreshResolve(evidence, dependencies)
  if (selected === "fresh") return

  save(join(consumer, "package.json"), {
    name: "factory-installed-proof",
    private: true,
    type: "module",
    packageManager: read(join(source, "package.json")).packageManager,
    dependencies,
    pnpm: { overrides },
  })
  runCommand(evidence, "consumer-lock", "pnpm", ["install", "--lockfile-only", "--ignore-scripts"], consumer)
  runCommand(evidence, "consumer-install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], consumer)

  const files = { ...sourceHashes }
  for (const file of [...distFiles(tarballs), join(consumer, "package.json"), join(consumer, "pnpm-lock.yaml")]) {
    files[file] = hash(file)
  }
  for (const { directory, manifest } of packages) {
    const installed = realpathSync(join(consumer, "node_modules", manifest.name))
    assert.ok(inside(consumer, installed), "Package resolves outside consumer")
    for (const file of distFiles(join(source, "packages", directory, "dist"))) {
      const target = join(installed, "dist", relative(join(source, "packages", directory, "dist"), file))
      assert.equal(hash(target), hash(file), `Installed build differs: ${file}`)
      files[file] = hash(file)
      files[target] = hash(target)
    }
    files[join(installed, "package.json")] = hash(join(installed, "package.json"))
  }
  const resolveModules = (name) => {
    const result = runCommand(evidence, name, process.execPath, [
      "--experimental-import-meta-resolve",
      "--input-type=module",
      "-e",
      `import { realpathSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
       const factory = import.meta.resolve('@agentrun/factory');
       const executor = import.meta.resolve('agentrun');
       const core = import.meta.resolve('@agentrun/core');
       console.log(JSON.stringify({ modules: [factory, executor, core].map(x => realpathSync(fileURLToPath(x))),
         cores: [core, import.meta.resolve('@agentrun/core', factory), import.meta.resolve('@agentrun/core', executor)].map(x => realpathSync(fileURLToPath(x))) }));`,
    ], consumer)
    const bindings = JSON.parse(result)
    verifyBindings(consumer, bindings.modules, bindings.cores)
    return bindings
  }
  const bindings = resolveModules("module-bindings-before")
  save(join(evidence, "installed-target.json"), {
    head,
    branch,
    parents,
    candidate,
    pullRequest,
    node: process.version,
    files,
    bindings,
  })
  verifyHashes(files)
  const cli = realpathSync(join(consumer, "node_modules/@agentrun/factory/dist/bin.mjs"))
  const driver = join(source, "packages/factory/scripts/factory-e2e.mjs")
  const journeys = join(evidence, "journeys")
  const listed = JSON.parse(
    runCommand(evidence, "declared-journeys", process.execPath, [
      driver,
      cli,
      join(evidence, "listed-journeys"),
      "list",
    ], source),
  ).names
  assert.equal(new Set(listed).size, listed.length, "Duplicate declared journeys")
  const required = selected === "all" ? listed : selected.split(",")
  assert.ok(required.length > 0 && required.every((name) => listed.includes(name)), "Unknown selected journey")
  save(join(evidence, "expected-journeys.json"), required)
  mkdirSync(journeys)
  const concurrency = availableParallelism()
  const runs = [
    ...required.map((name) => ({ name: `journey-${name}`, output: join(journeys, name), journey: name })),
    ...Array.from({ length: 10 }, (_, index) => ({
      name: `cancellation-${index + 1}`,
      output: join(evidence, `cancellation-${index + 1}`),
      journey: "cancel-agent",
    })),
  ]
  await runConcurrently(
    evidence,
    runs.map(({ name, output, journey }) => ({
      name,
      executable: process.execPath,
      argv: [driver, cli, output, journey],
      cwd: source,
    })),
    concurrency,
  )
  const results = mergeJourneyResults(
    runs.filter((run) => run.name.startsWith("journey-")).map((run) => read(join(run.output, "results.json"))),
  )
  save(join(journeys, "results.json"), results)
  verifyJourneys(results.outcomes, required)
  const cancellations = runs.filter((run) => run.name.startsWith("cancellation-"))
  for (const { output } of cancellations) verifyJourneys(read(join(output, "results.json")).outcomes, ["cancel-agent"])
  assert.equal(
    mergeJourneyResults(cancellations.map(({ output }) => read(join(output, "results.json")))).cliSha256,
    results.cliSha256,
  )
  assert.equal(read(join(runs[0].output, "results.json")).example, "notes-ts")
  const python = runCommand(evidence, "python-version", "python3", ["--version"], source).trim()
  const pythonOutput = join(evidence, "python-journeys")
  runCommand(
    evidence,
    "installed-python-journeys",
    process.execPath,
    [
      driver,
      cli,
      pythonOutput,
      pythonJourneys.join(","),
      "notes-py",
    ],
    source,
    3600000,
  )
  const pythonResults = read(join(pythonOutput, "results.json"))
  assert.equal(pythonResults.example, "notes-py")
  verifyJourneys(pythonResults.outcomes, pythonJourneys)
  verifyHashes(files)
  const finalBindings = resolveModules("module-bindings-after")
  assert.deepEqual(finalBindings, bindings)
  assert.equal(git("source-status-final", "status", "--porcelain"), "")
  save(join(evidence, "summary.json"), {
    result: "passed",
    head,
    branch,
    parents,
    candidate,
    pullRequest,
    scenarios: results.outcomes.length,
    cancellationRepeats: cancellations.length,
    concurrency,
    python,
    pythonScenarios: pythonResults.outcomes.length,
    paidProviderCalls: 0,
  })
  console.log(readFileSync(join(evidence, "summary.json"), "utf8"))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2], process.argv[3])
}
