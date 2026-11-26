import type { Effect } from 'effect'
import { Context } from 'effect'

import type { ExternalError } from '@/core/feature/workflow/domain/errors'
import type { RunId } from '@/core/feature/workflow/domain/identity'

import type { CommandId, Session, TurnReceipt, TurnRequest } from './model.ts'

/** The composition root supplies one native container handle per run, never per node. */
export class PiSandbox extends Context.Service<
  PiSandbox,
  Readonly<{
    ensureSession: (runId: RunId) => Effect.Effect<Session, ExternalError>
    submitTurn: (runId: RunId, input: TurnRequest) => Effect.Effect<TurnReceipt, ExternalError>
    /** Only an authoritative turn_not_found response maps to null. */
    getTurn: (runId: RunId, commandId: CommandId) => Effect.Effect<TurnReceipt | null, ExternalError>
    complete: (runId: RunId) => Effect.Effect<Session, ExternalError>
  }>
>()('flowdeck/PiSandbox') {}
