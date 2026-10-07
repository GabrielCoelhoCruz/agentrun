import { Effect, Exit, Fiber } from "effect"
import { spawnSync } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import * as OwnershipRecords from "../src/OwnershipRecords.js"

let directory: string
let file: string
const identity = { version: 1, runId: "run-0042", repoRoot: "/repo" }
const expected = JSON.stringify(identity)
const read = (content = expected) =>
  Effect.runPromise(OwnershipRecords.read(file, OwnershipRecords.RunReservation, content))
const refused = async () => expect(read()).rejects.toThrow()

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "agentrun-record-"))
  file = join(directory, "owner.json")
  await fs.writeFile(file, expected)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

for (const type of ["fifo", "directory", "socket", "symlink", "device"] as const) {
  test(`refuses ${type} without reading or opening it`, async () => {
    await fs.unlink(file)
    let socket: ReturnType<typeof createServer> | undefined
    if (type === "fifo") expect(spawnSync("mkfifo", [file]).status).toBe(0)
    if (type === "directory") await fs.mkdir(file)
    if (type === "symlink") await fs.symlink(join(directory, "target"), file)
    if (type === "device") file = "/dev/null"
    if (type === "socket") {
      socket = createServer()
      await new Promise<void>((resolve) => socket!.listen(file, resolve))
    }
    const open = vi.spyOn(fs, "open")
    try {
      await refused()
      expect(open).not.toHaveBeenCalled()
    } finally {
      if (socket !== undefined) await new Promise<void>((resolve) => socket!.close(() => resolve()))
    }
  })
}

for (
  const content of [
    "",
    "{",
    "null",
    "[]",
    "1",
    JSON.stringify({ ...identity, version: 2 }),
    JSON.stringify({ ...identity, runId: 3 }),
    JSON.stringify({ version: 1, runId: "run-0042" }),
    JSON.stringify({ ...identity, extra: true }),
    "\ufeff" + expected,
  ]
) {
  test(`refuses malformed/schema data ${JSON.stringify(content)}`, async () => {
    await fs.writeFile(file, content)
    await expect(read(content)).rejects.toThrow()
  })
}
test("refuses invalid UTF8 even when replacement decoding would match", async () => {
  const content = JSON.stringify({ ...identity, runId: "run-\ufffd" })
  const bytes = Buffer.from(content)
  const position = bytes.indexOf(Buffer.from("\ufffd"))
  await fs.writeFile(file, Buffer.concat([bytes.subarray(0, position), Buffer.from([0xff]), bytes.subarray(position + 3)]))
  await expect(read(content)).rejects.toThrow()
})
for (const field of ["version", "runId", "repoRoot"]) {
  test(`refuses foreign reservation ${field}`, async () => {
    await fs.writeFile(file, JSON.stringify({ ...identity, [field]: field === "version" ? 2 : "foreign" }))
    await refused()
  })
}
for (const field of ["runId", "repoRoot", "taskId", "path", "branch"]) {
  test(`refuses foreign receipt ${field}`, async () => {
    const receipt = { ...identity, taskId: "task", path: "/workspace", branch: "agentrun/task-0042" }
    await fs.writeFile(file, JSON.stringify({ ...receipt, [field]: "foreign" }))
    await expect(
      Effect.runPromise(OwnershipRecords.read(file, OwnershipRecords.BranchReceipt, JSON.stringify(receipt))),
    )
      .rejects.toThrow()
  })
}
test("requires exact serialized identity after schema validation", async () => {
  await fs.writeFile(file, JSON.stringify(identity, null, 2))
  await refused()
})
for (const size of [65535, 65536, 65537]) {
  test(`size boundary ${size}`, async () => {
    const prefix = JSON.stringify({ ...identity, runId: "" })
    const content = JSON.stringify({ ...identity, runId: "x".repeat(size - Buffer.byteLength(prefix)) })
    expect(Buffer.byteLength(content)).toBe(size)
    await fs.writeFile(file, content)
    if (size <= 65536) expect(await read(content)).toBe(content)
    else await expect(read(content)).rejects.toThrow()
  })
}
test("rejects sparse oversized input before open", async () => {
  await fs.truncate(file, 1024 * 1024 * 1024)
  const open = vi.spyOn(fs, "open")
  await refused()
  expect(open).not.toHaveBeenCalled()
})
test("generated limit counts UTF8 bytes", async () => {
  await Effect.runPromise(OwnershipRecords.validateGenerated("x".repeat(65536)))
  await expect(Effect.runPromise(OwnershipRecords.validateGenerated("é".repeat(32769)))).rejects.toThrow()
})

const instrument = (action: (handle: Awaited<ReturnType<typeof fs.open>>) => void) => {
  const open = fs.open.bind(fs)
  return vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    expect(args[1]).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
    const handle = await open(...args)
    action(handle)
    return handle
  })
}
test("handles short reads in the same fixed buffer and closes on success", async () => {
  let closed = 0
  const buffers = new Set<unknown>()
  instrument((handle) => {
    const original = handle.read.bind(handle)
    vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
      buffers.add(args[0])
      expect(args[0].length).toBe(65537)
      args[2] = Math.min(args[2], 3)
      return original(...args as Parameters<typeof original>)
    })
    const close = handle.close.bind(handle)
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closed++
      await close()
    })
  })
  expect(await read()).toBe(expected)
  expect(buffers.size).toBe(1)
  expect(closed).toBe(1)
})
for (
  const fault of [
    "replace-before-open",
    "device-before-open",
    "replace-after-open",
    "grow",
    "truncate",
    "same-size",
    "read-error",
    "premature-eof",
  ] as const
) {
  test(`refuses ${fault} and closes acquired handle`, async () => {
    let closed = 0
    let injected = false
    if (fault === "replace-before-open" || fault === "device-before-open") {
      const open = fs.open.bind(fs)
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        await fs.rename(file, join(directory, "original"))
        if (fault === "device-before-open") await fs.symlink("/dev/null", file)
        else await fs.writeFile(file, expected)
        injected = true
        const handle = await open(...args)
        const close = handle.close.bind(handle)
        vi.spyOn(handle, "close").mockImplementation(async () => {
          closed++
          await close()
        })
        return handle
      })
    } else {instrument((handle) => {
        const original = handle.read.bind(handle)
        vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
          if (!injected) {
            injected = true
            if (fault === "read-error") throw new Error("private contents must not escape")
            if (fault === "premature-eof") return { bytesRead: 0, buffer: args[0] }
            if (fault === "replace-after-open") {
              await fs.rename(file, join(directory, "original"))
              await fs.writeFile(file, expected)
            }
            if (fault === "grow") await fs.appendFile(file, " ")
            if (fault === "truncate") await fs.truncate(file, 1)
            if (fault === "same-size") {
              await fs.writeFile(file, expected)
              const stat = await handle.stat()
              await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 1000))
            }
          }
          return original(...args as Parameters<typeof original>)
        })
        const close = handle.close.bind(handle)
        vi.spyOn(handle, "close").mockImplementation(async () => {
          closed++
          await close()
        })
      })}
    await refused()
    expect(injected).toBe(true)
    expect(closed).toBe(fault === "device-before-open" ? 0 : 1)
    console.log(JSON.stringify({ marker: "ownership-reader-injection", fault, injected, closed }))
  })
}
for (const phase of ["acquisition", "read"]) {
  test(`interruption during ${phase} closes the handle`, async () => {
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let closed = 0
    const open = fs.open.bind(fs)
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed++
        await close()
      })
      if (phase === "acquisition") {
        entered()
        await gate
      } else {
        const original = handle.read.bind(handle)
        vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => {
          entered()
          await gate
          return original(...args as Parameters<typeof original>)
        })
      }
      return handle
    })
    const fiber = Effect.runFork(OwnershipRecords.read(file, OwnershipRecords.RunReservation, expected))
    await ready
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    release()
    await interrupted
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    expect(closed).toBe(1)
    console.log(JSON.stringify({ marker: "ownership-reader-interruption", phase, closed }))
  })
}
