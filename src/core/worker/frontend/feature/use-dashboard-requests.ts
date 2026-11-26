import { Effect } from 'effect'
import { useCallback, useState, useTransition } from 'react'

import type { Result } from './server.ts'

type Invoke = <A>(call: () => Promise<Result<A>>, success: (value: A) => void) => void

type DashboardRequests = Readonly<{
  error: string | undefined
  inFlight: boolean
  invoke: Invoke
}>

export const useDashboardRequests = (): DashboardRequests => {
  const [error, setError] = useState<string>()
  const [inFlight, transition] = useTransition()
  const invoke = useCallback<Invoke>(
    (call, success) => {
      setError(undefined)
      transition(async () => {
        const request = Effect.tryPromise({
          catch: () => 'The connection was interrupted. Refresh to check the current persisted state before retrying.',
          try: call,
        }).pipe(
          Effect.match({
            onFailure: setError,
            onSuccess: (result) => {
              if (result.ok) {
                success(result.value)
              } else {
                setError(result.message)
              }
            },
          }),
        )
        // oxlint-disable-next-line rules/no-effect-runtime-run -- A React transition awaits the one server operation it owns.
        await Effect.runPromise(request)
      })
    },
    [transition],
  )
  return { error, inFlight, invoke }
}
