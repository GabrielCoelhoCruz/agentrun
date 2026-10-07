import { Clock, Effect, Schema } from "effect"
import { existsSync, lstatSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Artifact, Digest, Fact, failure, project } from "./Domain.js"
import type { Event } from "./Domain.js"
import { canonical, io, sha256, syncDirectory } from "./Files.js"

export interface Blob {
  readonly digest: string
  readonly bytes: Uint8Array
}
export const blob = (bytes: string | Uint8Array): Blob => {
  const data = typeof bytes === "string" ? Buffer.from(bytes) : bytes
  return { digest: sha256(data), bytes: data }
}
const Row = Schema.Struct({
  seq: Schema.Int,
  at: Schema.Int,
  body: Schema.String,
  digest: Digest,
  previous: Schema.String,
})
const references = (fact: Fact): ReadonlyArray<string> => {
  switch (fact._tag) {
    case "WorkflowStarted":
      return [fact.run.profileArtifact, ...fact.run.inputs.map((input) => input.digest)]
    case "AttemptPrepared":
      return fact.attempt.kind === "check" ? [] : [fact.attempt.taskArtifact]
    case "ProcessCompleted":
      return fact.artifacts.map((artifact) => artifact.digest)
    case "OutputCaptured":
      return fact.artifacts.map((artifact) => artifact.digest)
    case "AgentRecorded":
      return [fact.candidate.reportDigest, fact.candidate.patchDigest]
    case "CheckRecorded":
      return fact.evidence.artifacts.map((artifact) => artifact.digest)
    case "ReviewRecorded":
      return [fact.reportDigest]
    case "FaultRecorded":
      return fact.artifacts?.map((artifact) => artifact.digest) ?? []
    case "ExportPrepared":
      return [fact.receipt.manifestDigest, ...fact.files.map((file) => file.digest)]
    default:
      return []
  }
}
const parseFact = Schema.decodeUnknownSync(Fact, { onExcessProperty: "error" })
const decodeFact = (value: unknown): Fact => {
  const fact = parseFact(value)
  if (fact._tag === "AttemptPrepared") {
    const { preparationHash, ...preparation } = fact.attempt
    if (sha256(canonical(preparation)) !== preparationHash) {
      throw failure("state", "Immutable attempt preparation has a different digest")
    }
  }
  return fact
}

export class Store {
  private constructor(readonly directory: string, private readonly database: DatabaseSync) {}

  static open(directory: string, create = false) {
    return Effect.acquireRelease(
      io("storage", () => {
        const file = join(directory, "workflow.sqlite")
        if (create) {
          mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
          mkdirSync(directory, { mode: 0o700 })
          syncDirectory(dirname(directory))
        } else if (!existsSync(file)) {
          throw failure("state", "Workflow state is missing. Preserve the directory and inspect the saved run.")
        }
        if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).size > 256 * 1024 * 1024)) {
          throw failure("state", "Workflow database is not a supported regular file")
        }
        const database = new DatabaseSync(file, { timeout: 3000, allowExtension: false })
        try {
          if (
            !create
            && (database.prepare("PRAGMA user_version").get()?.user_version !== 1
              || database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
          ) {
            throw failure(
              "state",
              "Workflow database is corrupt or has an unsupported version. Preserve it for inspection.",
            )
          }
          database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON")
          if (
            database.prepare("PRAGMA synchronous").get()?.synchronous !== 3
            || database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete"
          ) throw failure("storage", "SQLite durability settings differ from the required settings")
          if (create) {
            database.exec(`
            BEGIN IMMEDIATE;
            CREATE TABLE facts (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, previous TEXT NOT NULL) STRICT;
            CREATE TABLE artifacts (digest TEXT PRIMARY KEY, bytes BLOB NOT NULL) STRICT;
            PRAGMA user_version = 1;
            COMMIT;
          `)
          }
          if (
            database.prepare("PRAGMA user_version").get()?.user_version !== 1
            || database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok"
          ) {
            throw failure(
              "state",
              "Workflow database is corrupt or has an unsupported version. Preserve it for inspection.",
            )
          }
          if (create) syncDirectory(directory)
          return new Store(directory, database)
        } catch (cause) {
          database.close()
          throw cause
        }
      }),
      (store) => Effect.sync(() => store.database.close()),
    )
  }

  private eventsSync(): Array<Event> {
    const rows = Schema.decodeUnknownSync(Schema.Array(Row))(
      this.database.prepare("SELECT seq, at, body, digest, previous FROM facts ORDER BY seq").all(),
    )
    let previous = ""
    const events = rows.map((row, index) => {
      if (
        row.seq !== index + 1 || row.previous !== previous
        || row.digest !== sha256(`${row.seq}\n${row.at}\n${previous}\n${row.body}`)
      ) throw failure("state", "Workflow event sequence or digest is corrupt. Preserve the database.")
      previous = row.digest
      const parsed: unknown = JSON.parse(row.body)
      return { seq: row.seq, at: row.at, digest: row.digest, fact: decodeFact(parsed) }
    })
    if (events.length > 0) project(events)
    return events
  }

  readonly events = () => io("state", () => this.eventsSync())
  readonly read = () => this.events().pipe(Effect.map(project))

  readonly artifact = (digest: string) => io("artifact", () => this.artifactSync(digest))

  private artifactSync(digest: string): Uint8Array {
    const row = Schema.decodeUnknownSync(Schema.Struct({ bytes: Schema.Uint8Array }))(
      this.database.prepare("SELECT bytes FROM artifacts WHERE digest = ?").get(digest),
    )
    if (sha256(row.bytes) !== digest) {
      throw failure("artifact", "Artifact digest differs from its accepted content. Preserve the database.")
    }
    return row.bytes
  }

  readonly verify = () =>
    io("state", () => {
      const events = this.eventsSync()
      for (const event of events) for (const digest of references(event.fact)) this.artifactSync(digest)
      const all = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ digest: Digest })))(
        this.database.prepare("SELECT digest FROM artifacts").all(),
      )
      for (const row of all) this.artifactSync(row.digest)
      return project(events)
    })

  readonly append = (fact: Fact, blobs: ReadonlyArray<Blob> = [], expectedVersion?: number) =>
    Effect.gen({ self: this }, function*() {
      const at = yield* Clock.currentTimeMillis
      return yield* io("storage", () => {
        this.database.exec("BEGIN IMMEDIATE")
        try {
          const events = this.eventsSync()
          if (expectedVersion !== undefined && expectedVersion !== events.length) {
            throw failure("stale-command", "Workflow version changed. Read status and use its current request.")
          }
          const validated = decodeFact(fact)
          const seq = events.length + 1
          const body = JSON.stringify(validated)
          const previous = events.at(-1)?.digest ?? ""
          const digest = sha256(`${seq}\n${at}\n${previous}\n${body}`)
          const next = project([...events, { seq, at, digest, fact: validated }])
          for (const value of blobs) {
            if (sha256(value.bytes) !== value.digest) throw failure("artifact", "Prepared artifact digest differs")
            this.database.prepare("INSERT OR IGNORE INTO artifacts (digest, bytes) VALUES (?, ?)").run(
              value.digest,
              value.bytes,
            )
            this.artifactSync(value.digest)
          }
          for (const digest of references(validated)) this.artifactSync(digest)
          this.database.prepare("INSERT INTO facts (seq, at, body, digest, previous) VALUES (?, ?, ?, ?, ?)").run(
            seq,
            at,
            body,
            digest,
            previous,
          )
          this.database.exec("COMMIT")
          return next
        } catch (cause) {
          if (this.database.isTransaction) this.database.exec("ROLLBACK")
          throw cause
        }
      })
    })

  readonly allArtifacts = () =>
    io("artifact", () =>
      Schema.decodeUnknownSync(Schema.Array(Artifact))(
        this.database.prepare("SELECT digest, digest AS name FROM artifacts ORDER BY digest").all(),
      ))
}
