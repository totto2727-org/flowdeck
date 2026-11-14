import { Context, Effect } from 'effect'

import type { ExternalError } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'

import type { CommandId, Session, TurnReceipt, TurnRequest } from './model'

/** The composition root supplies one native container handle per run, never per node. */
export class PiSandbox extends Context.Service<
  PiSandbox,
  {
    readonly ensureSession: (runId: RunId) => Effect.Effect<Session, ExternalError>
    readonly submitTurn: (runId: RunId, input: TurnRequest) => Effect.Effect<TurnReceipt, ExternalError>
    /** Only an authoritative turn_not_found response maps to null. */
    readonly getTurn: (runId: RunId, commandId: CommandId) => Effect.Effect<TurnReceipt | null, ExternalError>
    readonly complete: (runId: RunId) => Effect.Effect<Session, ExternalError>
  }
>()('flowdeck/PiSandbox') {}
