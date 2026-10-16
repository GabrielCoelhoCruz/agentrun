import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Failure cases: echoed secrets, failed journeys, injected files, links, large files, and missing scan credentials.
const factory = fileURLToPath(new URL("../../../", import.meta.url))
const root = resolve(process.argv[2])
mkdirSync(root, { recursive: false })
const secret = "fake-journey-key-do-not-upload-123456"
const allowed = [
  "check-result.json",
  "decide.json",
  "exits.txt",
  "export.json",
  "factory-head.txt",
  "manifest-digests.json",
  "report.txt",
  "start.json",
  "toolchain.txt",
].sort()
const commands = []
const run = (command, args, env) => {
  const result = spawnSync(command, args, { cwd: factory, env, encoding: "utf8", timeout: 180000 })
  commands.push({
    command,
    args,
    cwd: factory,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout?.replaceAll(secret, "[REDACTED]"),
    stderr: result.stderr?.replaceAll(secret, "[REDACTED]"),
  })
  writeFileSync(join(root, "commands.json"), JSON.stringify(commands, null, 2))
  assert.equal(result.error, undefined, result.error?.message)
  return result
}
const files = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return lstatSync(path).isDirectory() ? files(path) : [path]
  })
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  USER: "fixture",
  TMPDIR: join(root, "private"),
  PYTHONDONTWRITEBYTECODE: "1",
  ANTHROPIC_API_KEY: secret,
  NODE_OPTIONS: `--import=${pathToFileURL(join(factory, "packages/factory/test/fixtures/provider-hooks.mjs")).href}`,
  FACTORY_FIXTURE_ECHO_SECRET: "1",
  FACTORY_FIXTURE_LOG: join(root, "providers.jsonl"),
  FACTORY_FIXTURE_DURABLE: join(factory, "packages/factory/test/fixtures/server-durable.ts"),
}
mkdirSync(env.HOME)
mkdirSync(env.TMPDIR)
const scanner = join(factory, "packages/factory/scripts/journey-evidence.py")
const scan = (directory, extra = {}) => run("python3", [scanner, "scan", directory], { ...env, ...extra })
for (const mode of ["happy", "no-change"]) {
  const out = join(root, mode)
  const result = run("bash", [
    "packages/factory/scripts/real-journey.sh",
    "--factory",
    factory,
    "--out",
    out,
    "--id",
    `secret-${mode}`,
  ], { ...env, FACTORY_FIXTURE_MODE: mode })
  assert.ok(!(result.stdout + result.stderr).includes(secret), "Journey must not print the secret")
  writeFileSync(join(root, `${mode}.log`), result.stdout + result.stderr)
  assert.equal(result.status, mode === "happy" ? 0 : 1, result.stdout + result.stderr)
  assert.match(result.stdout, mode === "happy" ? /RESULT PASS/ : /RESULT FAIL/)
  const leaked = files(out).filter((path) => readFileSync(path).includes(Buffer.from(secret)))
  assert.equal(leaked.length, 0, `Secret persisted in ${leaked.length} journey files`)
  assert.deepEqual(readdirSync(out).sort(), allowed, "Only approved evidence can remain")
  assert.deepEqual(readdirSync(env.TMPDIR), [], "Private run directory must be removed")
  assert.deepEqual(readdirSync(env.HOME), [], "Provider caches must stay within the private run")
  assert.equal(scan(out).status, 0)
  if (mode === "happy") {
    assert.match(readFileSync(join(out, "exits.txt"), "utf8"), /independent-check=0\nnegative-control=1/)
    assert.equal(JSON.parse(readFileSync(join(out, "check-result.json"))).criteria[0].outcome, "pass")
    assert.equal(JSON.parse(readFileSync(join(out, "export.json"))).stage, "exported")
  }
}
assert.ok(readFileSync(env.FACTORY_FIXTURE_LOG, "utf8").includes("\"kind\":\"secret-echo\""))
const good = join(root, "happy")
for (const name of ["report.txt", "extra.txt"]) {
  const bad = join(root, `leak-${name}`)
  cpSync(good, bad, { recursive: true })
  writeFileSync(join(bad, name), secret)
  const result = scan(bad)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /secret/i)
  assert.ok(!(result.stdout + result.stderr).includes(secret), "Scan must not print the secret")
  rmSync(bad, { recursive: true })
}
for (const kind of ["extra", "symlink", "large", "missing-key"]) {
  const bad = join(root, kind)
  cpSync(good, bad, { recursive: true })
  if (kind === "extra") writeFileSync(join(bad, "agent.log"), "private transcript")
  if (kind === "symlink") {
    rmSync(join(bad, "report.txt"))
    symlinkSync(join(good, "report.txt"), join(bad, "report.txt"))
  }
  if (kind === "large") writeFileSync(join(bad, "report.txt"), "x".repeat(65537))
  assert.equal(scan(bad, kind === "missing-key" ? { ANTHROPIC_API_KEY: "" } : {}).status, 1, kind)
  rmSync(bad, { recursive: true })
}
writeFileSync(join(root, "factory-head.txt"), run("git", ["rev-parse", "HEAD"], env).stdout)
run("git", ["status", "--short"], env)
console.log("PASS: echoed key excluded; injected leaks blocked; failed journey safe; no paid provider calls")
