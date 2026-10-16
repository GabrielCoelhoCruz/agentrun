import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { inside, readBytes, writeExclusive } from "../src/Files.js"

test.each([false, true])("exclusive retry cleans only its own temporary regular files (published: %s)", (published) => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-retry-"))
  const file = join(directory, "result.json")
  if (published) writeFileSync(file, "complete")
  writeFileSync(join(directory, ".result.json.partial-0123456789abcdef"), "incomplete")
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
  writeExclusive(file, "complete")
  expect(readFileSync(file, "utf8")).toBe("complete")
  expect(readdirSync(directory).sort()).toEqual([...preserved, linked, folder, "result.json"].sort())
  for (const name of [...preserved, linked]) expect(readFileSync(join(directory, name), "utf8")).toBe("preserve")
})

test("temporary paths cannot be read as published artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-read-"))
  const name = ".result.json.partial-0123456789abcdef"
  writeFileSync(join(directory, name), "incomplete")
  expect(() => readBytes(join(directory, name))).toThrow(/temporary/i)
  expect(() => inside(directory, name)).toThrow(/temporary/i)
  expect(() => inside(directory, `${name}/evidence.txt`)).toThrow(/temporary/i)
})

test("exclusive retry preserves temporary files when the published bytes differ", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-refuse-"))
  const file = join(directory, "result.json")
  const temporary = ".result.json.partial-0123456789abcdef"
  writeFileSync(file, "different")
  writeFileSync(join(directory, temporary), "incomplete")
  expect(() => writeExclusive(file, "complete")).toThrow(/Existing artifact differs/)
  expect(readFileSync(file, "utf8")).toBe("different")
  expect(readFileSync(join(directory, temporary), "utf8")).toBe("incomplete")
})

test("exclusive write accepts an identical existing file and leaves no other file", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-same-"))
  writeExclusive(join(directory, "result.json"), "{\"exitCode\":0}")
  writeExclusive(join(directory, "result.json"), Buffer.from("{\"exitCode\":0}"))
  expect(readFileSync(join(directory, "result.json"), "utf8")).toBe("{\"exitCode\":0}")
  expect(readdirSync(directory)).toEqual(["result.json"])
})

test("exclusive write refuses a different existing file and keeps its bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-exclusive-differs-"))
  writeFileSync(join(directory, "result.json"), "{\"exitCode\":1}")
  expect(() => writeExclusive(join(directory, "result.json"), "{\"exitCode\":0}")).toThrow(
    expect.objectContaining({ code: "artifact", message: expect.stringContaining("Existing artifact differs") }),
  )
  expect(readFileSync(join(directory, "result.json"), "utf8")).toBe("{\"exitCode\":1}")
  expect(readdirSync(directory)).toEqual(["result.json"])
})
