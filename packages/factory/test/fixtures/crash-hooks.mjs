import { existsSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

process.env.FACTORY_FIXTURE_COORDINATOR ??= String(process.pid)

const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql)
  if (!/INSERT INTO facts/i.test(sql)) return statement
  const run = statement.run.bind(statement)
  statement.run = (...args) => {
    const result = run(...args)
    const tag = process.env.FACTORY_FIXTURE_CRASH
    if (tag === undefined || existsSync(process.env.FACTORY_FIXTURE_CRASH_MARKER)) return result
    const fact = args.find((arg) => typeof arg === "string" && arg.includes(`"_tag":"${tag}"`))
    if (fact !== undefined) {
      this.exec("COMMIT")
      writeFileSync(process.env.FACTORY_FIXTURE_CRASH_MARKER, String(process.pid))
      process.kill(process.pid, "SIGKILL")
    }
    return result
  }
  return statement
}
