import { BrowserCrypto } from '@effect/platform-browser'
import { live } from '@effect/vitest'
import { RpcCallError } from 'alchemy/Rpc'
import { Effect, Schema } from 'effect'
import { expect } from 'vite-plus/test'

import {
  Conflict,
  ExternalError,
  InvalidOperation,
  InvalidSnapshot,
  NotFound,
  StorageConflict,
} from '@/core/feature/workflow/domain/errors'
import { rpcResponse, rpcResult } from '@/core/feature/workflow/rpc/boundary'
import { RemoteWorkerError } from '@/core/feature/workflow/rpc/problem'

import { openApi, post, responseJson, resumePath, unavailableWorkflows } from './control-api.fixture.ts'

const originalError = (message: string): Error =>
  // oxlint-disable-next-line rules/require-tagged-error -- Exercise failures from native operations without a domain tag.
  new Error(message)
const unexpected = originalError('private unexpected failure')
const sqlFailed = originalError('private SQL')
const toSchemaError = Effect.flip(Schema.decodeEffect(Schema.StringFromBase64)('invalid!'))
const cases = [
  { code: 'NotFound', failure: Effect.succeed(new NotFound({ resource: 'private graph' })), status: 404 },
  { code: 'Conflict', failure: Effect.succeed(new Conflict({ message: 'private conflict' })), status: 409 },
  {
    code: 'Conflict',
    failure: Effect.succeed(
      new StorageConflict({ cause: sqlFailed, message: 'private constraint', operation: 'batch' }),
    ),
    status: 409,
  },
  {
    code: 'InvalidOperation',
    failure: Effect.succeed(new InvalidOperation({ message: 'private recovery information' })),
    status: 409,
  },
  {
    code: 'InvalidSnapshot',
    failure: Effect.succeed(new InvalidSnapshot({ message: 'private checkpoint' })),
    status: 409,
  },
  {
    code: 'ExternalError',
    failure: Effect.succeed(
      new ExternalError({ cause: 'private database failure', kind: 'storage', operation: 'read run' }),
    ),
    status: 500,
  },
  {
    code: 'ExternalError',
    failure: Effect.succeed(
      new ExternalError({ cause: 'private disconnection', kind: 'service', operation: 'call workflow worker' }),
    ),
    status: 502,
  },
  {
    code: 'ExternalError',
    failure: Effect.succeed(new RpcCallError({ cause: 'private disconnection', method: 'resume' })),
    status: 500,
  },
  { code: 'InvalidRequest', failure: toSchemaError, status: 400 },
  { code: 'ExternalError', failure: Effect.succeed(unexpected), status: 500 },
]

const encodeRemoteFailure = Effect.fn('flowdeck.test.encodeRemoteFailure')(function* (reported: unknown) {
  return yield* Effect.fail(reported).pipe(rpcResponse('Workflow.resumeRun'), Effect.provide(BrowserCrypto.layer))
})

const readRemoteFailure = Effect.fn('flowdeck.test.readRemoteFailure')(function* (wire: string) {
  const local = yield* Effect.flip(rpcResult('Control.resumeRun')(wire))
  if (!(local instanceof RemoteWorkerError)) {
    return yield* local
  }
  return local
})

live.each(cases)('does not transmit the original $code cause through native RPC', ({ failure }) =>
  Effect.gen(function* () {
    const original = yield* failure
    const wire = yield* encodeRemoteFailure(original)
    expect(wire).not.toContain('private')
    expect(wire).not.toContain('stack')
    expect(yield* readRemoteFailure(wire)).not.toBe(original)
  }),
)

live.each(cases)('returns a sanitized $code over HTTP $status after RPC', ({ code, failure, status }) =>
  Effect.gen(function* () {
    const original = yield* failure
    const local = yield* encodeRemoteFailure(original).pipe(Effect.flatMap(readRemoteFailure))
    const request = yield* openApi({ ...unavailableWorkflows, resumeRun: () => Effect.fail(local) })
    const response = yield* request(resumePath, post)
    const body = yield* responseJson(response)
    expect(response.status).toBe(status)
    expect(body).toStrictEqual({ error: code, message: local.cause.detail })
    expect(JSON.stringify(body)).not.toContain('private')
    expect(body).not.toHaveProperty('stack')
    expect(body).not.toHaveProperty('cause')
  }),
)
