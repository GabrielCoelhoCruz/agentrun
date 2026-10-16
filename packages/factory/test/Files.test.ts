import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { writeExclusive } from "../src/Files.js"

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
