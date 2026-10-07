import fs, { existsSync, readFileSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { DatabaseSync } from "node:sqlite"

process.env.FACTORY_FIXTURE_COORDINATOR ??= String(process.pid)

const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql)
  if (!/INSERT INTO facts/i.test(sql)) return statement
  const run = statement.run.bind(statement)
  statement.run = (...args) => {
    if (
      process.env.FACTORY_FIXTURE_CRASH === "HumanDeciding"
      && !existsSync(process.env.FACTORY_FIXTURE_CRASH_MARKER)
      && args.some((arg) => typeof arg === "string" && arg.includes('"_tag":"HumanDecided"'))
    ) {
      writeFileSync(process.env.FACTORY_FIXTURE_CRASH_MARKER, String(process.pid))
      process.kill(process.pid, "SIGKILL")
    }
    const result = run(...args)
    const tag = process.env.FACTORY_FIXTURE_CRASH
    if (tag === undefined || existsSync(process.env.FACTORY_FIXTURE_CRASH_MARKER)) return result
    const fact = args.find((arg) => typeof arg === "string" && arg.includes(`"_tag":"${tag}"`))
    if (fact !== undefined) {
      if (process.env.FACTORY_FIXTURE_CRASH_KIND !== undefined) {
        const current = JSON.parse(fact)
        const attempt = current.attempt ?? this.prepare("SELECT body FROM facts ORDER BY seq DESC").all()
          .map((row) => JSON.parse(row.body)).find((row) =>
            row._tag === "AttemptPrepared" && row.attempt.id === current.attemptId
          )?.attempt
        if (attempt?.kind !== process.env.FACTORY_FIXTURE_CRASH_KIND) return result
      }
      this.exec("COMMIT")
      writeFileSync(process.env.FACTORY_FIXTURE_CRASH_MARKER, String(process.pid))
      process.kill(process.pid, "SIGKILL")
    }
    return result
  }
  return statement
}

const rename = fs.rename
fs.rename = (source, destination, callback) =>
  rename(source, destination, (error) => {
    if (
      !error && process.env.FACTORY_FIXTURE_CRASH === "executor-completed"
      && String(destination).endsWith("/state.json") && !existsSync(process.env.FACTORY_FIXTURE_CRASH_MARKER)
    ) {
      const state = JSON.parse(readFileSync(destination, "utf8"))
      if (Object.values(state.taskReports ?? {}).some((report) => report.phase === "completed")) {
        writeFileSync(process.env.FACTORY_FIXTURE_CRASH_MARKER, String(process.pid))
        process.kill(process.pid, "SIGKILL")
      }
    }
    callback(error)
  })
syncBuiltinESMExports()
