import { Context, Effect, Layer, Option, Ref } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { RunNotFound } from "./domain/Errors.js"
import type { StateCorrupted } from "./domain/Errors.js"
import type { RunState } from "./domain/RunState.js"

export class StateStore extends Context.Service<StateStore, {
  readonly load: (runId: string) => Effect.Effect<RunState, StateCorrupted | RunNotFound>
  readonly save: (state: RunState) => Effect.Effect<void, PlatformError>
  readonly latest: Effect.Effect<Option.Option<string>>
}>()("agentrun/StateStore") {
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
