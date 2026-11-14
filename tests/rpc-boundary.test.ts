import { ok } from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { Array, Option, Result, Schema } from 'effect'
import { Miniflare } from 'miniflare'
import { build } from 'vite-plus'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test'

import { Rfc9457ProblemDetails } from '@/core/feature/workflow/rpc/problem'

import type Parent from './fixtures/rpc-boundary-worker'

const decodeReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(Schema.Result(Schema.Json, Rfc9457ProblemDetails))),
  { onExcessProperty: 'error' },
)
const decodeLogs = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        operation: Schema.String,
        errorId: Schema.String,
        renderedCause: Schema.String,
        localStack: Schema.String,
        originalStack: Schema.String,
        remoteError: Schema.Boolean,
        externalError: Schema.Boolean,
        priorProblem: Schema.NullOr(Rfc9457ProblemDetails),
      }),
    ),
  ),
)

let script: string
let miniflare: Miniflare

// Miniflare exposes native RPC at runtime but types getWorker as a Fetcher only.
// Derive the RPC surface from the bundled fixture instead of inventing a second contract.
const entrypoint = async (name: string) =>
  (await miniflare.getWorker(name)) as unknown as Pick<Service<Parent>, 'start' | 'logs'>

beforeAll(async () => {
  const output = await build({
    configFile: false,
    resolve: { tsconfigPaths: true },
    logLevel: 'silent',
    build: {
      target: 'esnext',
      write: false,
      outDir: fileURLToPath(new URL('../tmp/rpc-boundary-build', import.meta.url)),
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./fixtures/rpc-boundary-worker.ts', import.meta.url)),
        formats: ['es'],
        fileName: 'rpc-boundary-worker',
      },
      rolldownOptions: { external: ['cloudflare:workers'] },
    },
  })
  const result = Array.isArray(output) ? output[0] : output
  ok(result && 'output' in result)
  const chunk = Array.findFirst(result.output, (entry) => entry.type === 'chunk')
  ok(Option.isSome(chunk) && chunk.value.type === 'chunk')
  script = chunk.value.code
})

beforeEach(() => {
  miniflare = new Miniflare({
    workers: [
      {
        name: 'parent',
        modules: true,
        script,
        compatibilityDate: '2026-07-30',
        serviceBindings: { CHILD: { name: 'child', entrypoint: 'Child' } },
      },
      { name: 'child', modules: true, script, compatibilityDate: '2026-07-30' },
    ],
  })
})

afterEach(async () => {
  await miniflare.dispose()
})

describe('native Worker RPC JSON boundary', () => {
  it('round-trips success across a real service binding without failure logs', async () => {
    const parent = await entrypoint('parent')
    const child = await entrypoint('child')
    const response = await parent.start('success')
    expect(typeof response).toBe('string')
    const reply = decodeReply(response)
    ok(Result.isSuccess(reply))
    expect(reply.success).toEqual({ answer: 42, values: [null, true, 'ok'] })
    expect(decodeLogs(await parent.logs())).toEqual([])
    expect(decodeLogs(await child.logs())).toEqual([])
  })

  it.each(['failure', 'not-found', 'defect'] as const)(
    'returns JSON text for a child %s and keeps private diagnostics in its originating isolate',
    async (scenario) => {
      const parent = await entrypoint('parent')
      const child = await entrypoint('child')
      const response = await parent.start(scenario)
      expect(typeof response).toBe('string')
      const reply = decodeReply(response)
      ok(Result.isFailure(reply))
      expect(reply.failure).toEqual({
        ...(scenario === 'not-found'
          ? {
              type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#not-found',
              title: 'not-found',
              status: 404,
              detail: 'The requested resource was not found.',
            }
          : scenario === 'failure'
            ? {
                type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#storage',
                title: 'storage',
                status: 500,
                detail: 'A persistence operation failed.',
              }
            : {
                type: 'https://github.com/totto2727-org/flowdeck/blob/main/docs/rpc-boundaries.md#internal',
                title: 'internal',
                status: 500,
                detail: 'The operation could not be completed.',
              }),
        instance: expect.any(String),
      })
      const childLogs = decodeLogs(await child.logs())
      const parentLogs = decodeLogs(await parent.logs())
      expect(childLogs).toHaveLength(1)
      expect(parentLogs).toHaveLength(1)
      const childLog = childLogs[0]
      const parentLog = parentLogs[0]
      ok(childLog && parentLog)
      expect(childLog.operation).toBe('child.start')
      expect(JSON.stringify(childLog)).toContain('PRIVATE_RPC_DATABASE_PASSWORD')
      expect(JSON.stringify(childLog)).toContain('childOnlyPrivateFrame')
      expect(childLog.remoteError).toBe(false)
      expect(childLog.externalError).toBe(scenario === 'failure')
      expect(parentLog).toMatchObject({
        operation: 'parent.start',
        errorId: reply.failure.instance,
        remoteError: true,
        externalError: false,
        originalStack: '',
        priorProblem: { ...reply.failure, instance: childLog.errorId },
      })
      expect(parentLog.errorId).not.toBe(childLog.errorId)
      expect(parentLog.renderedCause).toContain(childLog.errorId)
      expect(parentLog.localStack).toContain('RemoteWorkerError')
      expect(JSON.stringify(parentLog)).not.toContain('PRIVATE_RPC_DATABASE_PASSWORD')
      expect(JSON.stringify(parentLog)).not.toContain('childOnlyPrivateFrame')
      expect(response).not.toContain(childLog.errorId)
      expect(response).not.toContain('PRIVATE_RPC_DATABASE_PASSWORD')
      expect(response).not.toContain('childOnlyPrivateFrame')
      expect(response).not.toContain('RemoteWorkerError')
      expect(reply.failure).not.toHaveProperty('stack')
      expect(reply.failure).not.toHaveProperty('cause')
    },
  )
})
