import { Context, Effect } from 'effect'

import type { ExternalError } from '../../../features/workflow/domain/errors'
import type { Session, TurnReceipt, TurnRequest } from './model'

/** The composition root supplies one native container handle per run, never per node. */
export class DevelopmentSandbox extends Context.Service<
  DevelopmentSandbox,
  {
    readonly ensureSession: (runId: string) => Effect.Effect<Session, ExternalError>
    readonly submitTurn: (runId: string, input: TurnRequest) => Effect.Effect<TurnReceipt, ExternalError>
    /** Only an authoritative turn_not_found response maps to null. */
    readonly getTurn: (runId: string, commandId: string) => Effect.Effect<TurnReceipt | null, ExternalError>
    readonly complete: (runId: string) => Effect.Effect<Session, ExternalError>
  }
>()('flowdeck/DevelopmentSandbox') {}
