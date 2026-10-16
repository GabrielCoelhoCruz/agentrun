import { Effect } from "effect"
import { pack } from "tar-stream"
import type { Header } from "tar-stream"
import { failure } from "./Domain.js"
import { gitBytes, io } from "./Files.js"

const maximum = 64 * 1024 * 1024
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)

export const sourceArchive = Effect.fn("sourceArchive")(function*(repo: string, commit: string) {
  const tree = yield* gitBytes(repo, ["ls-tree", "-r", "-t", "-z", commit])
  const entries = yield* io("export", () =>
    text(tree).split("\0").filter(Boolean).map((entry) => {
      const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entry)
      if (match === null) throw failure("export", "Invalid candidate tree entry")
      const [, mode = "", kind, oid, name] = match
      if (mode === "160000" || kind === "commit") {
        throw failure("export", "Exact source export does not support tracked gitlinks (submodules)")
      }
      if (name === undefined || name.split("/").some((part) => ["", ".", "..", ".git"].includes(part))) {
        throw failure("export", "Candidate has an unsafe archive path")
      }
      const type = mode === "040000" && kind === "tree"
        ? "directory"
        : mode === "120000" && kind === "blob"
        ? "symlink"
        : (mode === "100644" || mode === "100755") && kind === "blob"
        ? "file"
        : undefined
      if (type === undefined || oid === undefined) throw failure("export", "Unsupported candidate tree entry")
      return { name, mode: type === "directory" ? 0o755 : Number.parseInt(mode, 8) & 0o777, oid, type } as const
    }))
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    return yield* failure("export", "Candidate has duplicate archive paths")
  }
  const files: Array<{ header: Partial<Header> & { name: string }; bytes: Buffer }> = []
  let size = 0
  for (const entry of entries) {
    const bytes = entry.type === "directory" ? Buffer.alloc(0) : yield* gitBytes(repo, ["cat-file", "blob", entry.oid])
    size += bytes.length
    if (size > maximum) return yield* failure("export", "Source archive exceeds 64 MiB")
    const linkname = entry.type === "symlink"
      ? yield* io("export", () => {
        const value = text(bytes)
        if (value.includes("\0")) throw failure("export", "Symlink target contains a null byte")
        return value
      })
      : ""
    files.push({
      header: { name: entry.name, mode: entry.mode, type: entry.type, mtime: new Date(0), linkname },
      bytes: entry.type === "file" ? bytes : Buffer.alloc(0),
    })
  }
  return yield* Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        const archive = pack()
        const chunks: Array<Buffer> = []
        let length = 0
        archive.on("data", (chunk) => {
          if (!Buffer.isBuffer(chunk)) {
            archive.destroy(new Error("Archive produced non-binary data"))
            return
          }
          length += chunk.length
          if (length > maximum) archive.destroy(new Error("Source archive exceeds 64 MiB"))
          else chunks.push(chunk)
        })
        archive.on("error", reject)
        archive.on("end", () => resolve(Buffer.concat(chunks)))
        for (const file of files) archive.entry(file.header, file.bytes)
        archive.finalize()
      }),
    catch: (cause) => failure("export", `Could not create exact source archive: ${String(cause)}`),
  })
})
