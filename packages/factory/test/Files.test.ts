import { Effect } from "effect"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { inside, io, readBytes, writeExclusive } from "../src/Files.js"

test("missing records retain the caller's error code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-missing-record-"))
  const file = join(directory, "owner.json")
  await expect(Effect.runPromise(io("executor-ownership", () => readBytes(file)))).rejects.toThrow(
    expect.objectContaining({ code: "executor-ownership" }),
  )
  expect(existsSync(file)).toBe(false)
})

test.each([false, true])(
  "exclusive retry preserves pre-existing temporary files (published: %s)",
  async (published) => {
    const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-retry-"))
    const file = join(directory, "result.json")
    if (published) writeFileSync(file, "complete")
    const stale = ".result.json.partial-0123456789abcdef"
    writeFileSync(join(directory, stale), "incomplete")
    const preserved = [
      ".other.json.partial-0123456789abcdef",
      ".result.json.extra.partial-0123456789abcdef",
      ".result.json.partial-0123456789abcdef-extra",
      ".result.json.partial-0123456789abcdeg",
    ]
    for (const name of preserved) writeFileSync(join(directory, name), "preserve")
    const linked = ".result.json.partial-1111111111111111"
    symlinkSync(".other.json.partial-0123456789abcdef", join(directory, linked))
    const folder = ".result.json.partial-2222222222222222"
    mkdirSync(join(directory, folder))
    await writeExclusive(file, "complete")
    expect(readFileSync(file, "utf8")).toBe("complete")
    expect(readdirSync(directory).sort()).toEqual([...preserved, stale, linked, folder, "result.json"].sort())
    for (const name of [...preserved, linked]) expect(readFileSync(join(directory, name), "utf8")).toBe("preserve")
  },
)

test("temporary paths cannot be read as published artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-read-"))
  const name = ".result.json.partial-0123456789abcdef"
  writeFileSync(join(directory, name), "incomplete")
  await expect(readBytes(join(directory, name))).rejects.toThrow(/temporary/i)
  expect(() => inside(directory, name)).toThrow(/temporary/i)
  expect(() => inside(directory, `${name}/evidence.txt`)).toThrow(/temporary/i)
})

test("exclusive retry preserves temporary files when the published bytes differ", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-refuse-"))
  const file = join(directory, "result.json")
  const temporary = ".result.json.partial-0123456789abcdef"
  writeFileSync(file, "different")
  writeFileSync(join(directory, temporary), "incomplete")
  await expect(writeExclusive(file, "complete")).rejects.toThrow(/Existing artifact differs/)
  expect(readFileSync(file, "utf8")).toBe("different")
  expect(readFileSync(join(directory, temporary), "utf8")).toBe("incomplete")
})

test("exclusive write accepts an identical existing file and leaves no other file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-same-"))
  await writeExclusive(join(directory, "result.json"), "{\"exitCode\":0}")
  await writeExclusive(join(directory, "result.json"), Buffer.from("{\"exitCode\":0}"))
  expect(readFileSync(join(directory, "result.json"), "utf8")).toBe("{\"exitCode\":0}")
  expect(readdirSync(directory)).toEqual(["result.json"])
})

test("exclusive write refuses a different existing file and keeps its bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-differs-"))
  writeFileSync(join(directory, "result.json"), "{\"exitCode\":1}")
  await expect(writeExclusive(join(directory, "result.json"), "{\"exitCode\":0}")).rejects.toThrow(
    expect.objectContaining({ code: "artifact", message: expect.stringContaining("Existing artifact differs") }),
  )
  expect(readFileSync(join(directory, "result.json"), "utf8")).toBe("{\"exitCode\":1}")
  expect(readdirSync(directory)).toEqual(["result.json"])
})

const writerScript = fileURLToPath(new URL("./fixtures/exclusive-writer.mjs", import.meta.url))
const writer = (directory: string, mode: string) =>
  spawnSync(process.execPath, [writerScript, directory, mode], {
    encoding: "utf8",
    timeout: 30000,
  })

test("exclusive retry preserves a matching user file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-user-"))
  const userFile = join(directory, ".result.json.partial-0123456789abcdef")
  writeFileSync(userFile, "user-owned bytes")
  await writeExclusive(join(directory, "result.json"), "complete")
  expect(readFileSync(userFile, "utf8")).toBe("user-owned bytes")
})

test.each([false, true])("exclusive write refuses a symlinked parent (dangling: %s)", async (dangling) => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-symlink-"))
  const outside = join(directory, "outside")
  if (!dangling) mkdirSync(outside)
  const parent = join(directory, "artifacts")
  symlinkSync(outside, parent, "dir")
  const userFile = join(outside, ".result.json.partial-0123456789abcdef")
  if (!dangling) writeFileSync(userFile, "outside user bytes")
  await expect(writeExclusive(join(parent, "result.json"), "complete")).rejects.toThrow(/symlink/i)
  if (!dangling) expect(readFileSync(userFile, "utf8")).toBe("outside user bytes")
  expect(existsSync(join(outside, "result.json"))).toBe(false)
})

test("exclusive write preserves a temporary file when exclusive creation collides", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-collision-"))
  const userFile = join(directory, ".result.json.partial-0123456789abcdef")
  writeFileSync(userFile, "user-owned bytes")
  const result = writer(directory, "collision")
  expect(result.status, result.stderr).toBe(1)
  expect(result.stdout).toContain("EEXIST")
  expect(readFileSync(userFile, "utf8")).toBe("user-owned bytes")
})

test("exclusive write retries a temporary name collision without changing the existing file", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-collision-retry-"))
  const stale = ".result.json.partial-0123456789abcdef"
  writeFileSync(join(directory, stale), "user-owned bytes")
  const result = writer(directory, "collision-once")
  expect(result.status, result.stderr + result.stdout).toBe(0)
  expect(readFileSync(join(directory, "result.json"), "utf8")).toBe("complete")
  expect(readFileSync(join(directory, stale), "utf8")).toBe("user-owned bytes")
  expect(readdirSync(directory).sort()).toEqual([stale, "result.json"])
})

test("exclusive write syncs publication while the complete temporary file still exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-sync-"))
  const result = writer(directory, "observe-sync")
  expect(result.status, result.stderr + result.stdout).toBe(0)
  expect(result.stdout).toContain(JSON.stringify({ published: "complete", temporary: "complete" }))
  expect(readdirSync(directory)).toEqual(["result.json"])
})

test.each([
  ["fail-directory-sync", "EIO"],
  ["fail-temporary-unlink", "EBUSY"],
])("exclusive write preserves an accepted artifact after %s", async (mode, code) => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-published-error-"))
  const result = writer(directory, mode)
  expect(result.status, result.stderr + result.stdout).toBe(1)
  expect(result.stdout).toContain(JSON.stringify({ read: "complete", accepted: true }))
  expect(result.stdout).toContain(`"code":"${code}"`)
  const file = join(directory, "result.json")
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, "utf8")).toBe("complete")
  await writeExclusive(file, "complete")
  expect(readFileSync(file, "utf8")).toBe("complete")
})

test.each(["root", "ancestor", "parent"])(
  "exclusive write rolls back its link when the %s becomes a symlink at publication",
  (component) => {
    const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-publish-symlink-"))
    mkdirSync(join(directory, "owned/artifacts/nested"), { recursive: true })
    const result = writer(directory, `publish-symlink-${component}`)
    const outside = join(
      directory,
      "outside",
      ...(component === "root"
        ? ["artifacts", "nested"]
        : component === "ancestor"
        ? ["nested"]
        : []),
    )
    expect(result.status, result.stderr + result.stdout).toBe(1)
    expect(result.stdout).toContain("\"code\":\"path\"")
    expect(existsSync(join(outside, "result.json"))).toBe(false)
    expect(readFileSync(join(outside, "user.txt"), "utf8")).toBe("user-owned bytes")
  },
)

test("exclusive write detects a different real parent and removes only its published link", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-publish-directory-"))
  mkdirSync(join(directory, "owned/artifacts/nested"), { recursive: true })
  const result = writer(directory, "publish-directory")
  expect(result.status, result.stderr + result.stdout).toBe(1)
  expect(result.stdout).toContain("\"code\":\"path\"")
  expect(existsSync(join(directory, "owned/artifacts/nested/result.json"))).toBe(false)
  expect(readFileSync(join(directory, "owned/artifacts/nested/user.txt"), "utf8")).toBe("user-owned bytes")
})

test.each(["replacement", "existing-same", "existing-different"])(
  "exclusive write preserves the %s artifact when publication detects a changed parent",
  (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-publish-preserve-"))
    mkdirSync(join(directory, "owned/artifacts/nested"), { recursive: true })
    const result = writer(directory, `publish-${mode}`)
    expect(result.status, result.stderr + result.stdout).toBe(1)
    expect(result.stdout).toContain("\"code\":\"path\"")
    expect(readFileSync(join(directory, "outside/result.json"), "utf8")).toBe(
      mode === "existing-same" ? "complete" : "user-owned artifact",
    )
  },
)

test("exclusive write cleans its own temporary file after a failed write", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-failure-"))
  const userFile = ".user-note.partial-0123456789abcdef"
  writeFileSync(join(directory, userFile), "user-owned bytes")
  const result = writer(directory, "fail")
  expect(result.status, result.stderr).toBe(1)
  expect(result.stdout).toContain("injected write failure")
  expect(readdirSync(directory)).toEqual([userFile])
})

test("exclusive write refuses a parent symlink before publication and cleanup", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-swap-"))
  mkdirSync(join(directory, "artifacts"))
  const result = writer(directory, "swap")
  expect(result.status, result.stderr).toBe(1)
  expect(result.stdout).toMatch(/symlink/i)
  expect(existsSync(join(directory, "outside/result.json"))).toBe(false)
  const temporary = readdirSync(join(directory, "outside")).find((name) => name.startsWith(".result.json.partial-"))
  expect(temporary).toBeDefined()
  expect(readFileSync(join(directory, "outside", temporary!), "utf8")).toBe("complete")
})

test("exclusive retry completes after a crash before publication and preserves the stale temporary file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-crash-"))
  const result = writer(directory, "crash")
  expect(result.signal, result.stderr).toBe("SIGKILL")
  expect(existsSync(join(directory, "result.json"))).toBe(false)
  const temporary = readdirSync(directory).find((name) => name.startsWith(".result.json.partial-"))
  expect(temporary).toBeDefined()
  await expect(readBytes(join(directory, temporary!))).rejects.toThrow(/temporary/i)
  await writeExclusive(join(directory, "result.json"), "complete")
  expect((await readBytes(join(directory, "result.json"))).toString()).toBe("complete")
  expect(readFileSync(join(directory, temporary!), "utf8")).toBe("complete")
})

test("exclusive writers in two processes preserve each other's active temporary files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-processes-"))
  const child = spawn(process.execPath, [writerScript, directory, "pause"], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (data) => {
    stdout += String(data)
  })
  child.stderr.on("data", (data) => {
    stderr += String(data)
  })
  const completed = new Promise<number | null>((done) => child.on("close", done))
  try {
    const deadline = Date.now() + 20000
    while (!existsSync(join(directory, "paused"))) {
      if (Date.now() > deadline) throw new Error(`Writer did not pause: ${stderr}`)
      await new Promise((done) => setTimeout(done, 10))
    }
    const temporary = readFileSync(join(directory, "paused"), "utf8")
    await writeExclusive(join(directory, "result.json"), "complete")
    const activePreserved = existsSync(temporary)
    writeFileSync(join(directory, "release"), "go")
    expect(await completed, stderr + stdout).toBe(0)
    expect(activePreserved).toBe(true)
    expect((await readBytes(join(directory, "result.json"))).toString()).toBe("complete")
    expect(readdirSync(directory).filter((name) => name.includes("partial"))).toEqual([])
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await completed
  }
}, 30000)

test("exclusive write refuses nested symlinks and paths outside its declared root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-root-"))
  const root = join(directory, "export")
  const outside = join(directory, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  symlinkSync(outside, join(root, "artifacts"), "dir")
  await expect(writeExclusive(join(root, "artifacts/nested/result.json"), "complete", root)).rejects.toThrow(/symlink/i)
  await expect(writeExclusive(join(outside, "result.json"), "complete", root)).rejects.toThrow(/outside/i)
  expect(readdirSync(outside)).toEqual([])
})
