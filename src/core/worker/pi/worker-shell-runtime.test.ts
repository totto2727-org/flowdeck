import { layer } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vite-plus/test'

import { WorkerShellHost } from './worker-shell-host.fixture.ts'

const shellResult = Schema.Struct({ exitCode: Schema.Number, stderr: Schema.String, stdout: Schema.String })
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Workerd returns untyped JSON over the native service boundary.
const decodeShellResult = Schema.decodeUnknownEffect(shellResult)
const persisted = { text: 'durable workspace' }
const ready = { fetchStatus: 404, jobs: 0 }

layer(WorkerShellHost.layer, { timeout: '60 seconds' })('official DO-only Pi workspace', (it) => {
  it.effect('initializes the real PiHarness without Container or Gateway provisioning', () =>
    Effect.gen(function* () {
      const { read } = yield* WorkerShellHost
      expect(yield* read('/sdk')).toStrictEqual(ready)
      expect(yield* read('/sdk')).toStrictEqual(ready)
    }),
  )

  it.effect('reaches durable files through the native Alchemy bridge after the previous Scope closes', () =>
    Effect.gen(function* () {
      const { read } = yield* WorkerShellHost
      expect(yield* read('/write')).toStrictEqual({ written: true })
      expect(yield* read('/read')).toStrictEqual(persisted)
      expect(yield* read('/exec')).toMatchObject({ exitCode: 0, stderr: '', stdout: persisted.text })
      expect(yield* read('/read')).toStrictEqual(persisted)
    }),
  )

  it.effect('reports an unsupported Node command in the DO-local shell', () =>
    Effect.gen(function* () {
      const { read } = yield* WorkerShellHost
      const response = yield* read('/unsupported')
      const { exitCode, stderr, stdout } = yield* decodeShellResult(response)
      expect({ exitCode, stdout }).toStrictEqual({ exitCode: 127, stdout: '' })
      expect(stderr).toContain('node')
    }),
  )
})
