import { Context, Effect } from 'effect'

import type { Session, TurnReceipt, TurnRequest } from '../../../features/development/model'
import type { BindingError } from '../../../features/workflow/domain/errors'

/** The composition root supplies one native container handle per run, never per node. */
export class DevelopmentSandbox extends Context.Service<
  DevelopmentSandbox,
  {
    readonly ensureSession: (runId: string) => Effect.Effect<Session, BindingError>
    readonly submitTurn: (runId: string, input: TurnRequest) => Effect.Effect<TurnReceipt, BindingError>
    /** Only an authoritative turn_not_found response maps to null. */
    readonly getTurn: (runId: string, commandId: string) => Effect.Effect<TurnReceipt | null, BindingError>
    readonly complete: (runId: string) => Effect.Effect<Session, BindingError>
  }
>()('flowdeck/DevelopmentSandbox') {}
