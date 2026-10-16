import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
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
const partial = /^\..+\.partial-[0-9a-f]{16}$/
// Publishes complete bytes only: the final path appears through link, which never replaces an existing file.
export const writeExclusive = (file: string, bytes: string | Uint8Array) => {
  const accept = () => {
    if (sha256(readBytes(file, 64 * 1024 * 1024)) !== sha256(bytes)) {
      throw failure("artifact", `Existing artifact differs; preserve and inspect: ${file}`)
    }
  }
  if (existsSync(file)) return accept()
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(file)}.partial-${randomBytes(8).toString("hex")}`)
  try {
    const fd = openSync(temporary, "wx", 0o600)
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(temporary, file)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return accept()
      throw cause
    }
  } finally {
    rmSync(temporary, { force: true })
  }
  syncDirectory(directory)
}
// Removes files that a crashed writeExclusive left behind. Call only while holding the directory's writer lock.
export const removePartials = (directory: string) => {
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && partial.test(entry.name)) rmSync(join(entry.parentPath, entry.name))
  }
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
