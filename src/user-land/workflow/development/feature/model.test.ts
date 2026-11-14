import { Machine } from '@typeonce/effect-machine'
import { Array, Effect, Option, Schema, String } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CommandId, SessionId, TurnReceipt, TurnRequest } from '@/core/feature/pi/model'

import { DevelopmentSnapshot, DevelopmentSnapshotJson, initialDevelopmentSnapshot } from './development'
import { DevelopmentMachine, DevelopmentStates } from './development-machine'
import { developmentVersion, PublicRepository } from './input'

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
  it('rejects an empty prompt with the official nonempty string schema', () => {
    expect(Schema.is(TurnRequest)({ commandId, prompt: '' })).toBe(false)
  })

  it('accepts prefixed UUIDv4 operation identities through the standard Schema check', () => {
    expect(Schema.decodeUnknownSync(CommandId)(commandId)).toBe(commandId)
    expect(Schema.decodeUnknownSync(TurnRequest)({ commandId, prompt: 'Verify the change.' })).toEqual({
      commandId,
      prompt: 'Verify the change.',
    })
  })

  it.each([
    'run:implement:1',
    'not-a-uuid',
    '3d360c7a-4b1a-4df3-9633-861a220bf5b7',
    'command_3d360c7a-4b1a-1df3-9633-861a220bf5b7',
  ])('rejects non-v4 new operation identity %s', (invalid) => {
    expect(() => Schema.decodeUnknownSync(CommandId)(invalid)).toThrow()
  })

  it('rejects receipts from legacy operation histories', () => {
    const receipt = { commandId: 'old-run:verify:1', status: 'completed', text: 'done' }
    expect(() => Schema.decodeUnknownSync(TurnReceipt)(receipt)).toThrow()
  })

  it('accepts only the official root session identity', () => {
    expect(Schema.decodeUnknownSync(SessionId)('1')).toBe('1')
    expect(() => Schema.decodeUnknownSync(SessionId)('replacement-session')).toThrow()
  })

  it.each([
    'implement.intent',
    'implement.awaiting',
    'implement.polling',
    'implement.accepted',
    'verify.intent',
    'verify.awaiting',
    'verify.polling',
    'verify.completing',
  ])('validates command and execution identities in native %s checkpoints', async (path) => {
    const initial = await Effect.runPromise(Machine.decodeSnapshot(DevelopmentMachine, initialSnapshot.machine))
    const encoded = await Effect.runPromise(Machine.encodeSnapshot(DevelopmentMachine, initial))
    const parent = String.startsWith('implement.')(path) ? 'implement' : 'verify'
    const tag = Option.getOrThrow(Array.last(String.split('.')(path)))
    const value = {
      _tag: tag,
      commandId,
      executionId: 'execution_3d360c7a-4b1a-4df3-9633-861a220bf5b7',
      attempt: 1,
      ...(tag === 'accepted' || tag === 'completing' ? { result: 'done' } : {}),
    }
    const active = [...Array.filter(encoded.active, (entry) => entry.path === ''), { path: parent }, { path, value }]
    const wire = { ...encoded, active }
    const restored = await Effect.runPromise(Machine.decodeSnapshot(DevelopmentMachine, wire))
    expect(await Effect.runPromise(Machine.encodeSnapshot(DevelopmentMachine, restored))).toMatchObject({ active })
    await expect(
      Effect.runPromise(
        Machine.decodeSnapshot(DevelopmentMachine, {
          ...wire,
          active: [...Array.dropRight(active, 1), { path, value: { ...value, commandId: 'run:verify:1' } }],
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'MachineSchemaDecodeError' })
    await expect(
      Effect.runPromise(
        Machine.decodeSnapshot(DevelopmentMachine, {
          ...wire,
          active: [...Array.dropRight(active, 1), { path, value: { ...value, executionId: commandId } }],
        }),
      ),
    ).rejects.toMatchObject({ _tag: 'MachineSchemaDecodeError' })
  })

  it('round-trips native versions and repository values through both snapshot codecs', async () => {
    const encoded = encodeDevelopmentSnapshot(initialSnapshot)
    expect(encoded).toMatchObject({ version: '1.0.0', machine: { _tag: 'MachineSnapshot', version: 2 } })
    expect(encoded).not.toHaveProperty('context')
    const decoded = decodeDevelopmentSnapshot(encoded)
    expect(decoded).toEqual(initialSnapshot)
    expect(Schema.is(DevelopmentSnapshot)(encoded)).toBe(false)
    const state = await Effect.runPromise(Machine.decodeSnapshot(DevelopmentMachine, decoded.machine))
    const root = Option.getOrThrow(DevelopmentStates.get(state, ''))
    expect(root.version).toEqual(developmentVersion)
    expect(root.repository).toBeInstanceOf(URL)
    expect(root.repository.href).toBe('https://github.com/example/project')
    expect(await Effect.runPromise(Machine.encodeSnapshot(DevelopmentMachine, state))).toEqual(decoded.machine)
  })

  it('keeps native repository URLs in the domain and uses the official wire codec', () => {
    const codec = Schema.toCodecJson(PublicRepository)
    const repository = Schema.decodeUnknownSync(codec)('https://GITHUB.COM/example/other/../project')
    expect(repository).toBeInstanceOf(URL)
    expect(repository.href).toBe('https://github.com/example/project')
    expect(Schema.encodeSync(codec)(repository)).toBe('https://github.com/example/project')
    expect(Schema.is(PublicRepository)('https://github.com/example/project')).toBe(false)
  })
})
