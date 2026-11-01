import { ALCHEMY_DEV } from 'alchemy'
import { Effect, Layer } from 'effect'

/** Select a complete application, never individual feature implementations. */
export const applicationMode = ALCHEMY_DEV.pipe(
  Effect.map((development) => (development ? 'development' : 'production')),
)

export const applicationDependencies = Effect.gen(function* () {
  const mode = yield* applicationMode
  // Deployment-only providers must not enter the fixed frontend runtime graph.
  const application = yield* Effect.promise(() => import('./application'))
  return mode === 'development' ? application.DevelopmentLayer : application.ProductionLayer
})

export const ApplicationLayer = Layer.unwrap(applicationDependencies)
