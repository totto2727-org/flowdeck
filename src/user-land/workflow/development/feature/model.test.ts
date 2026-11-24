import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { Array, Effect, Option, Schema, String } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { CommandId, SessionId, TurnReceipt, TurnRequest } from '@/core/feature/pi/model'

import { DevelopmentMachine, DevelopmentStates } from './development-machine.ts'
import { DevelopmentSnapshot, DevelopmentSnapshotJson, initialDevelopmentSnapshot } from './development.ts'
import { developmentVersion, PublicRepository } from './input.ts'

const decodeCommandId = Schema.decodeUnknownSync(CommandId)
const decodeTurnRequest = Schema.decodeUnknownSync(TurnRequest)
const decodeTurnReceipt = Schema.decodeUnknownSync(TurnReceipt)
const decodeSessionId = Schema.decodeUnknownSync(SessionId)

const encodeDevelopmentSnapshot = Schema.encodeSync(DevelopmentSnapshotJson)
const decodeDevelopmentSnapshot = Schema.decodeUnknownSync(DevelopmentSnapshotJson)
const initialSnapshot = initialDevelopmentSnapshot({
  workflowId: 'jcode-development',
  version: developmentVersion,
  repository: new URL('https://github.com/example/project'),
  task: 'Verify the change.',
})

const commandId = 'command_3d360c7a-4b1a-4df3-9633-861a220bf5b7'

describe('development operation wire schemas', () => {
  test('rejects an empty prompt with the official nonempty string schema', () => {
    expect(Schema.is(TurnRequest)({ commandId, prompt: '' })).toBe(false)
  })

  test('accepts prefixed UUIDv4 operation identities through the standard Schema check', () => {
    expect(decodeCommandId(commandId)).toBe(commandId)
    expect(decodeTurnRequest({ commandId, prompt: 'Verify the change.' })).toStrictEqual({
      commandId,
      prompt: 'Verify the change.',
    })
  })

  test.each([
    'run:implement:1',
    'not-a-uuid',
    '3d360c7a-4b1a-4df3-9633-861a220bf5b7',
    'command_3d360c7a-4b1a-1df3-9633-861a220bf5b7',
  ])('rejects non-v4 new operation identity %s', (invalid) => {
    expect(() => decodeCommandId(invalid)).toThrow()
  })

  test('rejects receipts from legacy operation histories', () => {
    const receipt = { commandId: 'old-run:verify:1', status: 'completed', text: 'done' }
    expect(() => decodeTurnReceipt(receipt)).toThrow()
  })

  test('accepts only the official root session identity', () => {
    expect(decodeSessionId('1')).toBe('1')
    expect(() => decodeSessionId('replacement-session')).toThrow()
  })

  live.each([
    'implement.intent',
    'implement.awaiting',
    'implement.polling',
    'implement.accepted',
    'verify.intent',
    'verify.awaiting',
    'verify.polling',
    'verify.completing',
  ])('validates command and execution identities in native %s checkpoints', (path) =>
    Effect.gen(function* () {
      const initial = yield* Machine.decodeSnapshot(DevelopmentMachine, initialSnapshot.machine)
      const encoded = yield* Machine.encodeSnapshot(DevelopmentMachine, initial)
      const parent = String.startsWith('implement.')(path) ? 'implement' : 'verify'
      const tag = Option.getOrThrow(Array.last(String.split('.')(path)))
      const value = {
        _tag: tag,
        commandId,
        executionId: 'execution_3d360c7a-4b1a-4df3-9633-861a220bf5b7',
        attempt: 1,
        ...(tag === 'accepted' || tag === 'completing' ? { result: 'done' } : {}),
      }
      const active = [
        ...Array.filter(encoded.active, (entry) => String.isEmpty(entry.path)),
        { path: parent },
        { path, value },
      ]
      const wire = { ...encoded, active }
      const restored = yield* Machine.decodeSnapshot(DevelopmentMachine, wire)
      expect(yield* Machine.encodeSnapshot(DevelopmentMachine, restored)).toMatchObject({
        active,
      })
      expect(
        yield* Effect.flip(
          Machine.decodeSnapshot(DevelopmentMachine, {
            ...wire,
            active: [...Array.dropRight(active, 1), { path, value: { ...value, commandId: 'run:verify:1' } }],
          }),
        ),
      ).toMatchObject({ _tag: 'MachineSchemaDecodeError' })
      expect(
        yield* Effect.flip(
          Machine.decodeSnapshot(DevelopmentMachine, {
            ...wire,
            active: [...Array.dropRight(active, 1), { path, value: { ...value, executionId: commandId } }],
          }),
        ),
      ).toMatchObject({ _tag: 'MachineSchemaDecodeError' })
    }),
  )

  live('round-trips native versions and repository values through both snapshot codecs', () =>
    Effect.gen(function* () {
      const encoded = encodeDevelopmentSnapshot(initialSnapshot)
      expect(encoded).toMatchObject({ machine: { _tag: 'MachineSnapshot', version: 2 }, version: '1.0.0' })
      expect(encoded).not.toHaveProperty('context')
      const decoded = decodeDevelopmentSnapshot(encoded)
      expect(decoded).toStrictEqual(initialSnapshot)
      expect(Schema.is(DevelopmentSnapshot)(encoded)).toBe(false)
      const state = yield* Machine.decodeSnapshot(DevelopmentMachine, decoded.machine)
      const root = Option.getOrThrow(DevelopmentStates.get(state, ''))
      expect(root.version).toStrictEqual(developmentVersion)
      expect(root.repository).toBeInstanceOf(URL)
      expect(root.repository.href).toBe('https://github.com/example/project')
      expect(yield* Machine.encodeSnapshot(DevelopmentMachine, state)).toStrictEqual(decoded.machine)
    }),
  )

  test('keeps native repository URLs in the domain and uses the official wire codec', () => {
    const codec = Schema.toCodecJson(PublicRepository)
    const repository = Schema.decodeUnknownSync(codec)('https://GITHUB.COM/example/other/../project')
    expect(repository).toBeInstanceOf(URL)
    expect(repository.href).toBe('https://github.com/example/project')
    expect(Schema.encodeSync(codec)(repository)).toBe('https://github.com/example/project')
    expect(Schema.is(PublicRepository)('https://github.com/example/project')).toBe(false)
  })
})
