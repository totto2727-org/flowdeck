import { Schema } from 'effect'

import { RunId } from '@/core/feature/workflow/domain/identity'

// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Native Worker RPC callers can send unchecked values despite the TypeScript contract.
export const decodeRunId = Schema.decodeUnknownEffect(RunId)

// oxlint-disable-next-line unicorn/no-null -- Command RPC success encodes an explicit JSON null.
export const commandAcknowledgement = null
