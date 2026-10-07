import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { FactoryError, failure, RelativePath } from "./Domain.js"

const exec = promisify(execFile)
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : entry)
export const io = <A>(code: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof FactoryError
        ? cause
        : failure(code, `${code}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
export const readBytes = (file: string, maximum = 16 * 1024 * 1024): Buffer => {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > maximum) {
    throw failure("artifact", `Expected a regular file of at most ${maximum} bytes: ${file}`)
  }
  return readFileSync(file)
}
export const readJson = (file: string): unknown => JSON.parse(readBytes(file).toString("utf8"))
export const syncDirectory = (directory: string) => {
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
export const writeExclusive = (file: string, bytes: string | Uint8Array) => {
  if (existsSync(file)) {
    if (sha256(readBytes(file, 64 * 1024 * 1024)) !== sha256(bytes)) {
      throw failure("artifact", `Existing artifact differs; preserve and inspect: ${file}`)
    }
    return
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const fd = openSync(file, "wx", 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dirname(file))
}
export const inside = (root: string, name: string) => {
  Schema.decodeUnknownSync(RelativePath)(name)
  const file = resolve(root, name)
  const rel = relative(root, file)
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw failure("path", "Path leaves its declared directory")
  }
  return file
}
export const gitBytes = (repo: string, argv: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => exec("git", argv, { cwd: repo, encoding: "buffer", timeout: 30000, maxBuffer: 64 * 1024 * 1024 }),
    catch: (cause) =>
      failure("git", `Git ${argv[0] ?? "command"} failed: ${cause instanceof Error ? cause.message : String(cause)}`),
  }).pipe(Effect.map((result) => result.stdout))
export const git = (repo: string, argv: ReadonlyArray<string>) =>
  gitBytes(repo, argv).pipe(Effect.map((bytes) => bytes.toString("utf8").trim()))
