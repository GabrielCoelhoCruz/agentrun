import { OwnershipRecords } from "@agentrun/core"
import { Effect, Schema } from "effect"
import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { FactoryError, failure, RelativePath } from "./Domain.js"

const exec = promisify(execFile)
const partial = /^\.(.+)\.partial-[0-9a-f]{16}$/
export const temporaryPath = (file: string) => file.split(/[\\/]/).some((name) => partial.test(name))
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : entry)
export const io = <A>(code: string, operation: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: async (): Promise<A> => operation(),
    catch: (cause) =>
      cause instanceof FactoryError
        ? cause
        : failure(code, `${code}: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
export const readBytes = async (file: string, maximum = 16 * 1024 * 1024): Promise<Buffer> => {
  if (temporaryPath(file)) throw failure("artifact", `Cannot read a temporary artifact: ${file}`)
  return Effect.runPromise(
    OwnershipRecords.readBytes(file, maximum).pipe(
      Effect.mapError((error) =>
        error.code === "ENOENT"
          ? Object.assign(new Error(`ENOENT: no such file: ${file}`), { code: "ENOENT" })
          : failure("artifact", `Expected a stable regular file of at most ${maximum} bytes: ${file}`)
      ),
    ),
  )
}
export const readJson = async (file: string): Promise<unknown> => JSON.parse((await readBytes(file)).toString("utf8"))
export const syncDirectory = (directory: string) => {
  const fd = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
// Check the owned root and each existing component before filesystem changes.
export const safePath = (root: string, file: string) => {
  const directory = resolve(root)
  const target = resolve(file)
  const rel = relative(directory, target)
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw failure("path", `Path is outside its owned directory: ${file}`)
  }
  let current = directory
  for (const component of ["", ...(rel === "" ? [] : rel.split(sep))]) {
    current = join(current, component)
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (stat === undefined) break
    if (stat.isSymbolicLink()) throw failure("path", `Refusing symlink in owned path: ${current}`)
    if (current !== target && !stat.isDirectory()) throw failure("path", `Expected a directory: ${current}`)
  }
  return target
}
// Publishes complete bytes only: link never replaces an existing file. Crashed writers' temporary files stay unreadable.
export const writeExclusive = async (file: string, bytes: string | Uint8Array, root = dirname(file)) => {
  safePath(root, file)
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const parents: Array<{ path: string; dev: bigint; ino: bigint }> = []
  let current = resolve(root)
  const rel = relative(current, resolve(directory))
  for (const component of ["", ...(rel === "" ? [] : rel.split(sep))]) {
    current = join(current, component)
    const stat = lstatSync(current, { bigint: true })
    if (!stat.isDirectory()) throw failure("path", `Expected a real directory: ${current}`)
    parents.push({ path: current, dev: stat.dev, ino: stat.ino })
  }
  const checkParents = () => {
    safePath(root, file)
    for (const parent of parents) {
      const stat = lstatSync(parent.path, { bigint: true, throwIfNoEntry: false })
      if (stat === undefined || !stat.isDirectory() || stat.dev !== parent.dev || stat.ino !== parent.ino) {
        throw failure("path", `Owned directory changed during publication: ${parent.path}`)
      }
    }
  }
  const accept = async () => {
    checkParents()
    if (sha256(await readBytes(file, 64 * 1024 * 1024)) !== sha256(bytes)) {
      throw failure("artifact", `Existing artifact differs; preserve and inspect: ${file}`)
    }
    checkParents()
    syncDirectory(directory)
    checkParents()
  }
  if (existsSync(file)) return accept()
  let temporary: string
  let fd: number
  for (let attempt = 0;; attempt++) {
    temporary = join(directory, `.${basename(file)}.partial-${randomBytes(8).toString("hex")}`)
    checkParents()
    safePath(root, temporary)
    try {
      fd = openSync(temporary, "wx", 0o600)
      break
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 9) throw cause
    }
  }
  try {
    const identity = fstatSync(fd, { bigint: true })
    const removeOwnLink = (path: string) => {
      const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false })
      if (stat?.isFile() && stat.dev === identity.dev && stat.ino === identity.ino) unlinkSync(path)
    }
    let published = false
    try {
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
        checkParents()
        safePath(root, temporary)
        try {
          linkSync(temporary, file)
          published = true
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "EEXIST") return await accept()
          throw cause
        }
        checkParents()
        syncDirectory(directory)
      } finally {
        checkParents()
        safePath(root, temporary)
        removeOwnLink(temporary)
      }
    } catch (cause) {
      // Path-based checks narrow the race; Node has no atomic directory-relative unlink.
      if (published) removeOwnLink(file)
      throw cause
    }
  } finally {
    closeSync(fd)
  }
}
export const inside = (root: string, name: string) => {
  Schema.decodeUnknownSync(RelativePath)(name)
  if (temporaryPath(name)) throw failure("artifact", `Cannot use a temporary artifact path: ${name}`)
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
