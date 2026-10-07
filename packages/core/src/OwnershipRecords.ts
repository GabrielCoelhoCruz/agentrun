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
export class OwnershipRecordError extends Schema.TaggedError<OwnershipRecordError>()("OwnershipRecordError", {}) {}
const refused = () => new OwnershipRecordError({})
const valid = (stat: BigIntStats) => stat.isFile() && stat.size <= BigInt(limit)
const same = (left: BigIntStats, right: BigIntStats) =>
  valid(right) && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: refused })

// lstat also reserves dangling links; following them would hide a collision.
export const exists = (file: string) => attempt(() => fs.lstat(file).then(() => true).catch((error: unknown) => {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
  throw error
}))

export const validateGenerated = (content: string): Effect.Effect<void, OwnershipRecordError> =>
  Buffer.byteLength(content, "utf8") <= limit ? Effect.void : Effect.fail(refused())

export const read = Effect.fn("OwnershipRecords.read")(
  function*(file: string, schema: typeof RunReservation | typeof BranchReceipt, expected: string) {
    const before = yield* attempt(() => fs.lstat(file, { bigint: true }))
    if (!valid(before)) return yield* refused()
    // Acquisition is uninterruptible so a late open cannot leak its handle.
    const handle = yield* Effect.acquireRelease(
      attempt(() => fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)),
      (handle) => attempt(() => handle.close()).pipe(Effect.orDie),
    )
    if (!same(before, yield* attempt(() => handle.stat({ bigint: true })))) return yield* refused()
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = yield* attempt(() => handle.read(buffer, offset, buffer.length - offset, offset))
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > limit || BigInt(offset) !== before.size) return yield* refused()
    if (!same(before, yield* attempt(() => handle.stat({ bigint: true })))) return yield* refused()
    if (!same(before, yield* attempt(() => fs.lstat(file, { bigint: true })))) return yield* refused()
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset)),
      catch: refused,
    })
    const json = yield* Effect.try({ try: (): unknown => JSON.parse(content), catch: refused })
    yield* Schema.decodeUnknownEffect(schema)(json, { onExcessProperty: "error" }).pipe(Effect.mapError(refused))
    if (content !== expected) return yield* refused()
    return content
  },
  Effect.scoped,
)
