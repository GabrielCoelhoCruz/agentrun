import { ClaudeCode, Pi } from "@agentrun/core"
import { Clock, Effect, Schema } from "effect"
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs"
import { delimiter, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { Environment, failure, Id, ProjectProfile } from "./Domain.js"
import type { WorkflowRun } from "./Domain.js"
import { git, gitBytes, inside, io, readBytes, sha256 } from "./Files.js"
import { blob } from "./Store.js"
import type { Blob } from "./Store.js"

export const executorIdentity = () =>
  io("executor", () => {
    const index = fileURLToPath(import.meta.resolve("agentrun"))
    const core = fileURLToPath(import.meta.resolve("@agentrun/core"))
    const bins = [dirname(index), dirname(core)].flatMap((directory) =>
      readdirSync(directory).filter((name) => name.endsWith(".mjs")).sort().map((name) => ({
        name,
        digest: sha256(readBytes(join(directory, name))),
      }))
    )
    const bin = join(dirname(index), "bin.mjs")
    readBytes(bin)
    return { bin, digest: sha256(JSON.stringify(bins)) }
  })

export const repository = (cwd: string) =>
  Effect.gen(function*() {
    const root = yield* git(cwd, ["rev-parse", "--show-toplevel"])
    const common = yield* git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    return yield* io("repository", () => ({ repoRoot: realpathSync(root), commonDir: realpathSync(common) }))
  })

const resolveExecutable = (name: string, repoRoot: string) => {
  const candidates = name.includes("/")
    ? [inside(repoRoot, name)]
    : (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, name))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      const executable = realpathSync(candidate)
      if (!lstatSync(executable).isFile()) continue
      return { executable, executableHash: sha256(readBytes(executable, 256 * 1024 * 1024)) }
    } catch {
      continue
    }
  }
  throw failure("profile", `Required command is unavailable: ${name}`, 2)
}

export const prepareProfile = (repoRoot: string, commonDir: string, file: string, goal: string, id: string) =>
  Effect.gen(function*() {
    const parsed = yield* io("profile", () => {
      try {
        Schema.decodeUnknownSync(Id)(id)
        const bytes = readBytes(inside(repoRoot, file), 1024 * 1024)
        const raw: unknown = JSON.parse(bytes.toString("utf8"))
        const profile = Schema.decodeUnknownSync(ProjectProfile, { onExcessProperty: "error" })(raw)
        if (goal.trim() === "") throw failure("profile", "Goal must not be empty", 2)
        return { profile, bytes }
      } catch {
        throw failure(
          "profile",
          "Invalid project profile, workflow ID, or goal. Check version, fields, paths, and required acceptance criteria.",
          2,
        )
      }
    })
    const profile = parsed.profile
    const checkIds = profile.checks.map((check) => check.id)
    if (
      new Set(checkIds).size !== checkIds.length
      || new Set(profile.acceptance.map((criterion) => criterion.id)).size !== profile.acceptance.length
    ) return yield* failure("profile", "Check and acceptance IDs must be unique", 2)
    for (const criterion of profile.acceptance) {
      if (!checkIds.includes(criterion.check)) {
        return yield* failure("profile", `Acceptance ${criterion.id} names an unknown check`, 2)
      }
    }
    for (const check of profile.checks) {
      if (!profile.acceptance.some((criterion) => criterion.check === check.id)) {
        return yield* failure("profile", `Check ${check.id} has no acceptance criterion`, 2)
      }
      if (
        new Set(check.files).size !== check.files.length || new Set(check.requiredEnv).size !== check.requiredEnv.length
      ) return yield* failure("profile", `Check ${check.id} has duplicate inputs`, 2)
      for (const name of check.requiredEnv) {
        if (
          [
            "FACTORY_RUN_ID",
            "FACTORY_ATTEMPT_ID",
            "FACTORY_CHECK_ID",
            "FACTORY_CANDIDATE",
            "FACTORY_ARTIFACT_DIR",
            "FACTORY_RESULT",
            "FACTORY_WORKSPACE",
          ].includes(name)
        ) return yield* failure("profile", `Environment name is reserved: ${name}`, 2)
        if (process.env[name] === undefined || process.env[name] === "") {
          return yield* failure("profile", `Required environment name is missing: ${name}`, 2)
        }
      }
    }
    for (const [name, role] of Object.entries(profile.roles)) {
      const capabilities = (role.agent === "pi" ? Pi.adapter : ClaudeCode.adapter).capabilities
      if (name === "review" && capabilities.readOnlyTools !== true) {
        return yield* failure("profile", "Review provider does not support read-only tools", 2)
      }
      if (role.maxTurns !== undefined && !capabilities.maxTurns) {
        return yield* failure("profile", `${role.agent} does not support maxTurns`, 2)
      }
      if (
        (role.maxBudgetUsd !== undefined || profile.limits.providerBudgetUsd !== undefined)
        && !capabilities.maxBudgetUsd
      ) return yield* failure("profile", `${role.agent} does not support the requested provider budget`, 2)
      if (role.model !== undefined && !capabilities.model) {
        return yield* failure("profile", `${role.agent} does not support model selection`, 2)
      }
    }
    const baseSha = yield* git(repoRoot, ["rev-parse", "--verify", `${profile.base}^{commit}`])
    if ((yield* git(repoRoot, ["status", "--porcelain"])) !== "") {
      return yield* failure(
        "profile",
        "Start requires a clean project checkout. Commit the profile and project files first.",
        2,
      )
    }
    const profileAtBase = yield* gitBytes(repoRoot, ["show", `${baseSha}:${file}`]).pipe(
      Effect.mapError(() => failure("profile", "The profile must exist at the selected base", 2)),
    )
    if (sha256(profileAtBase) !== sha256(parsed.bytes)) {
      return yield* failure("profile", "The profile differs from the selected base", 2)
    }
    const blobs: Array<Blob> = [blob(parsed.bytes)]
    const paths = [
      ...new Set([
        profile.roles.implement.instructions,
        profile.roles.review.instructions,
        ...profile.checks.flatMap((check) => check.files),
      ]),
    ]
    const inputs: Array<{ name: string; digest: string }> = []
    for (const name of paths) {
      const bytes = yield* gitBytes(repoRoot, ["show", `${baseSha}:${name}`]).pipe(
        Effect.mapError(() => failure("profile", `Declared input is missing at the base: ${name}`, 2)),
      )
      const current = yield* io("profile", () => {
        const path = inside(repoRoot, name)
        if (relative(repoRoot, realpathSync(path)) !== name) {
          throw failure("profile", `Declared input must be a regular project file: ${name}`, 2)
        }
        return readBytes(path)
      }).pipe(Effect.mapError(() => failure("profile", `Declared input is unavailable: ${name}`, 2)))
      if (sha256(current) !== sha256(bytes)) {
        return yield* failure("profile", `Declared input differs from the base: ${name}`, 2)
      }
      const value = blob(bytes)
      blobs.push(value)
      inputs.push({ name, digest: value.digest })
    }
    const executables: Record<string, typeof Environment.Type> = {}
    for (const check of profile.checks) {
      if (check.argv[0].includes("/") && !check.files.includes(check.argv[0])) {
        return yield* failure("profile", "Project executable must be listed in the check files", 2)
      }
      const identity = yield* io("profile", () => resolveExecutable(check.argv[0], repoRoot))
      executables[check.id] = {
        ...identity,
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        requiredEnv: check.requiredEnv,
      }
    }
    const roles = {
      implement: sha256(
        JSON.stringify({
          ...profile.roles.implement,
          input: inputs.find((input) => input.name === profile.roles.implement.instructions)?.digest,
        }),
      ),
      review: sha256(
        JSON.stringify({
          ...profile.roles.review,
          tools: "read-only",
          input: inputs.find((input) => input.name === profile.roles.review.instructions)?.digest,
        }),
      ),
    }
    const checkHashes = Object.fromEntries(
      profile.checks.map((check) => [
        check.id,
        sha256(
          JSON.stringify({
            check,
            files: inputs.filter((input) => check.files.includes(input.name)),
            executable: executables[check.id],
          }),
        ),
      ]),
    )
    const profileHash = sha256(JSON.stringify({ profile, inputs, roles, checkHashes }))
    const run: WorkflowRun = {
      id,
      repoRoot,
      commonDir,
      baseSha,
      profile,
      profileHash,
      profileArtifact: sha256(parsed.bytes),
      goal,
      startedAt: yield* Clock.currentTimeMillis,
      inputs,
      roleHashes: roles,
      checkHashes,
      executables,
      executor: yield* executorIdentity(),
    }
    return { run, blobs }
  })
