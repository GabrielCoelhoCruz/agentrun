import { Effect, Schema } from "effect"
import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import fs from "node:fs/promises"

export const limit = 65536
export const RunReservation = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  repoRoot: Schema.String,
})
export const BranchReceipt = Schema.Struct({
  ...RunReservation.fields,
  taskId: Schema.String,
  path: Schema.String,
  branch: Schema.String,
})

// Contents and native error details are deliberately excluded from diagnostics.
export class OwnershipRecordError extends Schema.TaggedError<OwnershipRecordError>()("OwnershipRecordError", {
  code: Schema.optional(Schema.Literal("ENOENT")),
}) {}
const refused = (cause?: unknown) =>
  new OwnershipRecordError(
    typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
      ? { code: "ENOENT" }
      : {},
  )
const valid = (stat: BigIntStats, maximum: number) => stat.isFile() && stat.size <= BigInt(maximum)
const sameContent = (left: BigIntStats, right: BigIntStats, maximum: number) =>
  valid(right, maximum) && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.size === right.size && left.mtimeNs === right.mtimeNs
const same = (left: BigIntStats, right: BigIntStats, maximum: number) =>
  sameContent(left, right, maximum) && left.ctimeNs === right.ctimeNs
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: refused })

// lstat also reserves dangling links; following them would hide a collision.
export const exists = (file: string) =>
  attempt(() =>
    fs.lstat(file).then(() => true).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
      throw error
    })
  )

export const validateGenerated = (content: string): Effect.Effect<void, OwnershipRecordError> =>
  Buffer.byteLength(content, "utf8") <= limit ? Effect.void : Effect.fail(refused())

export const readBytes = Effect.fn("OwnershipRecords.readBytes")(
  function*(file: string, maximum = limit) {
    const entry = yield* attempt(() => fs.lstat(file, { bigint: true }))
    if (!valid(entry, maximum)) return yield* refused()
    // Acquisition is uninterruptible so a late open cannot leak its handle.
    const handle = yield* Effect.acquireRelease(
      attempt(() =>
        fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
      ),
      (handle) => attempt(() => handle.close()).pipe(Effect.orDie),
    )
    const before = yield* attempt(() => handle.stat({ bigint: true }))
    if (!valid(before, maximum)) return yield* refused()
    if (entry.dev === before.dev && entry.ino === before.ino && !sameContent(entry, before, maximum)) {
      return yield* refused()
    }
    const buffer = Buffer.alloc(Math.min(maximum, Math.max(limit, Number(before.size))) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = yield* attempt(() => handle.read(buffer, offset, buffer.length - offset, offset))
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maximum || BigInt(offset) !== before.size) return yield* refused()
    // Atomic replacement can unlink this inode and change ctime without changing its bytes.
    if (!sameContent(before, yield* attempt(() => handle.stat({ bigint: true })), maximum)) return yield* refused()
    return buffer.subarray(0, offset)
  },
  Effect.scoped,
)

export const read = Effect.fn("OwnershipRecords.read")(
  function*(file: string, schema: typeof RunReservation | typeof BranchReceipt, expected: string) {
    const before = yield* attempt(() => fs.lstat(file, { bigint: true }))
    const bytes = yield* readBytes(file)
    if (!same(before, yield* attempt(() => fs.lstat(file, { bigint: true })), limit)) return yield* refused()
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: refused,
    })
    const json = yield* Effect.try({ try: (): unknown => JSON.parse(content), catch: refused })
    yield* Schema.decodeUnknownEffect(schema)(json, { onExcessProperty: "error" }).pipe(Effect.mapError(refused))
    if (content !== expected) return yield* refused()
    return content
  },
)
