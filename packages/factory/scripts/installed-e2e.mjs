import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
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

export const runCommand = (evidence, name, executable, argv, cwd, timeout = 900000) => {
  const started = new Date().toISOString()
  const result = spawnSync(executable, argv, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 })
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

const distFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? distFiles(file) : [file]
  })

const main = (directory, selected = "all") => {
  const evidence = resolve(directory)
  mkdirSync(evidence, { recursive: false })
  assert.ok(!inside(source, evidence), "Installed evidence must be outside the checkout")
  const git = (name, ...argv) => runCommand(evidence, name, "git", argv, source).trim()
  const head = git("source-head", "rev-parse", "HEAD")
  const branch = git("source-branch", "branch", "--show-current")
  const parents = git("source-parents", "show", "-s", "--format=%P", "HEAD").split(" ")
  const candidate = {
    head: process.env.AGENTRUN_CANDIDATE_HEAD ?? head,
    base: process.env.AGENTRUN_CANDIDATE_BASE ?? null,
  }
  assert.equal(git("source-status", "status", "--porcelain"), "", "Source checkout is dirty")
  const tracked = runCommand(evidence, "source-files", "git", ["ls-files", "-z"], source).split("\0").filter(Boolean)
  const sourceHashes = Object.fromEntries(tracked.map((file) => [join(source, file), hash(join(source, file))]))
  save(join(evidence, "source.json"), {
    head,
    branch,
    parents,
    candidate,
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
  const overrides = {}
  const dependencies = {}
  const { parse } = createRequire(join(source, "packages/core/package.json"))("yaml")
  const lock = parse(readFileSync(join(source, "pnpm-lock.yaml"), "utf8"))
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
    node: process.version,
    files,
    bindings,
  })
  verifyHashes(files)
  const cli = realpathSync(join(consumer, "node_modules/@agentrun/factory/dist/bin.mjs"))
  const driver = join(source, "packages/factory/scripts/factory-e2e.mjs")
  const journeys = join(evidence, "journeys")
  const listed =
    JSON.parse(
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
  runCommand(evidence, "installed-journeys", process.execPath, [driver, cli, journeys, selected], source, 7200000)
  const results = read(join(journeys, "results.json"))
  verifyJourneys(results.outcomes, required)
  for (let repeat = 1; repeat <= 10; repeat++) {
    const output = join(evidence, `cancellation-${repeat}`)
    runCommand(evidence, `cancellation-${repeat}`, process.execPath, [driver, cli, output, "cancel-agent"], source)
    verifyJourneys(read(join(output, "results.json")).outcomes, ["cancel-agent"])
  }
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
    scenarios: results.outcomes.length,
    cancellationRepeats: 10,
    paidProviderCalls: 0,
  })
  console.log(readFileSync(join(evidence, "summary.json"), "utf8"))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv[3])
}
