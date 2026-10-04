import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { RunNotFound, StateCorrupted } from "./domain/Errors.js"
import { RunState } from "./domain/RunState.js"

export class StateStore extends Context.Service<StateStore, {
  readonly load: (runId: string) => Effect.Effect<RunState, StateCorrupted | RunNotFound>
  readonly save: (state: RunState) => Effect.Effect<void, PlatformError>
  readonly latest: Effect.Effect<Option.Option<string>>
}>()("agentrun/StateStore") {
  static readonly layerFile = (options: { readonly repoRoot: string }) =>
    Layer.effect(
      StateStore,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const codec = Schema.toCodecJson(RunState)
        const runs = path.join(options.repoRoot, ".agentrun", "runs")
        const file = (runId: string) => path.join(runs, runId, "state.json")
        const load = Effect.fn("StateStore.load")(function*(runId: string) {
          const target = file(runId)
          const content = yield* fs.readFileString(target).pipe(Effect.mapError((error) =>
            error.reason._tag === "NotFound"
              ? new RunNotFound({ runId })
              : new StateCorrupted({ path: target, issue: error.message })
          ))
          const json = yield* Effect.try({
            try: (): unknown =>
              JSON.parse(content),
            catch: (error) => new StateCorrupted({ path: target, issue: String(error) }),
          })
          return yield* Schema.decodeUnknownEffect(codec)(json).pipe(
            Effect.mapError((error) => new StateCorrupted({ path: target, issue: error.message })),
          )
        })
        const save = Effect.fn("StateStore.save")(function*(state: RunState) {
          const target = file(state.runId)
          const encoded = yield* Schema.encodeEffect(codec)(state).pipe(Effect.orDie)
          yield* fs.makeDirectory(path.dirname(target), { recursive: true })
          yield* fs.writeFileString(`${target}.tmp`, JSON.stringify(encoded, null, 2))
          yield* fs.rename(`${target}.tmp`, target)
        })
        const latest = Effect.gen(function*() {
          const entries = yield* fs.readDirectory(runs).pipe(Effect.catch((error) =>
            error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.die(error)
          ))
          for (const id of entries.sort().reverse()) {
            if (yield* fs.exists(file(id)).pipe(Effect.orDie)) return Option.some(id)
          }
          return Option.none<string>()
        })
        return StateStore.of({ load, save, latest })
      }),
    )

  static readonly layerMemory = Layer.effect(
    StateStore,
    Effect.gen(function*() {
      const states = yield* Ref.make(new Map<string, RunState>())

      const load = Effect.fn("StateStore.load")(function*(runId: string) {
        const state = (yield* Ref.get(states)).get(runId)
        if (state === undefined) return yield* new RunNotFound({ runId })
        return state
      })

      const save = Effect.fn("StateStore.save")(function*(state: RunState) {
        yield* Ref.update(states, (current) => {
          const next = new Map(current)
          next.delete(state.runId)
          next.set(state.runId, state)
          return next
        })
      })

      const latest = Ref.get(states).pipe(
        Effect.map((current) => Option.fromUndefinedOr([...current.keys()].at(-1))),
      )

      return StateStore.of({ load, save, latest })
    }),
  )
}
