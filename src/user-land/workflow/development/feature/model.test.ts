import { live } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { Array, Data, Effect, Option, Predicate, Schema, String } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { CommandId, SessionId, TurnReceipt, TurnRequest } from '@/core/feature/pi/model'

import { DevelopmentMachine, DevelopmentStates } from './development-machine.ts'
import { DevelopmentSnapshot, DevelopmentSnapshotJson, initialDevelopmentSnapshot } from './development.ts'
import { developmentVersion, PublicRepository } from './input.ts'

const decodeCommandId = Schema.decodeEffect(CommandId)
const decodeTurnRequest = Schema.decodeEffect(TurnRequest)
const decodeTurnReceipt = Schema.decodeEffect(TurnReceipt)
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- Deliberately decode raw wire values rejected by the literal root-session schema.
const decodeSessionId = Schema.decodeUnknownEffect(SessionId)
const isTurnRequest = Schema.is(TurnRequest)
const isNativeSnapshot = Schema.is(DevelopmentSnapshot)
const isRepository = Schema.is(PublicRepository)
const isDecodeError = Predicate.isTagged('MachineSchemaDecodeError')

const encodeDevelopmentSnapshot = Schema.encodeEffect(DevelopmentSnapshotJson)
const decodeDevelopmentSnapshot = Schema.decodeEffect(DevelopmentSnapshotJson)
const wireMetadata = Schema.Struct({
  machine: Schema.TaggedStruct('MachineSnapshot', { version: Schema.Literal(2) }),
  version: Schema.Literal('1.0.0'),
})
// oxlint-disable-next-line rules/prefer-non-unknown-decode -- The JSON codec returns a generic JSON value at the wire boundary.
const decodeWireMetadata = Schema.decodeUnknownEffect(wireMetadata)
const repositoryUrl = 'https://github.com/example/project'
const initialCheckpoint = initialDevelopmentSnapshot({
  repository: new URL(repositoryUrl),
  task: 'Verify the change.',
  version: developmentVersion,
  workflowId: 'jcode-development',
})
const repositoryCodec = Schema.toCodecJson(PublicRepository)
const decodeRepository = Schema.decodeEffect(repositoryCodec)
const encodeRepository = Schema.encodeEffect(repositoryCodec)
const commandId = 'command_3d360c7a-4b1a-4df3-9633-861a220bf5b7'
const legacyCommandId = 'run:verify:1'

describe('development operation wire schemas', () => {
  test('rejects an empty prompt with the official nonempty string schema', () => {
    expect(isTurnRequest({ commandId, prompt: '' })).toBe(false)
  })

  live('accepts prefixed UUIDv4 operation identities through the standard Schema check', () =>
    Effect.gen(function* () {
      expect(yield* decodeCommandId(commandId)).toBe(commandId)
      const turn = { commandId, prompt: 'Verify the change.' }
      expect(yield* decodeTurnRequest(turn)).toStrictEqual(turn)
    }),
  )

  live.each([
    'run:implement:1',
    'not-a-uuid',
    '3d360c7a-4b1a-4df3-9633-861a220bf5b7',
    'command_3d360c7a-4b1a-1df3-9633-861a220bf5b7',
  ])('rejects non-v4 new operation identity %s', (invalid) =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(decodeCommandId(invalid))).toBeInstanceOf(Schema.SchemaError)
    }),
  )

  live('rejects receipts from legacy operation histories', () =>
    Effect.gen(function* () {
      const receipt = { commandId: 'old-run:verify:1', status: 'completed', text: 'done' } as const
      expect(yield* Effect.flip(decodeTurnReceipt(receipt))).toBeInstanceOf(Schema.SchemaError)
    }),
  )

  live('accepts only the official root session identity', () =>
    Effect.gen(function* () {
      expect(yield* decodeSessionId('1')).toBe('1')
      expect(yield* Effect.flip(decodeSessionId('replacement-session'))).toBeInstanceOf(Schema.SchemaError)
    }),
  )
})

type IdentityFields = Readonly<{ attempt: number; commandId: string; executionId: string }>
type CompletedTurn = IdentityFields & Readonly<{ result: string }>
type WireCheckpoint = Data.TaggedEnum<{
  accepted: CompletedTurn
  awaiting: IdentityFields
  completing: CompletedTurn
  intent: IdentityFields
  polling: IdentityFields
}>
const wireCheckpoint = Data.taggedEnum<WireCheckpoint>()
const identity = { attempt: 1, commandId, executionId: 'execution_3d360c7a-4b1a-4df3-9633-861a220bf5b7' }
const completedTurn = { ...identity, result: 'done' }
const checkpoints = [
  { parent: 'implement', path: 'implement.intent', value: wireCheckpoint.intent(identity) },
  { parent: 'implement', path: 'implement.awaiting', value: wireCheckpoint.awaiting(identity) },
  { parent: 'implement', path: 'implement.polling', value: wireCheckpoint.polling(identity) },
  { parent: 'implement', path: 'implement.accepted', value: wireCheckpoint.accepted(completedTurn) },
  { parent: 'verify', path: 'verify.intent', value: wireCheckpoint.intent(identity) },
  { parent: 'verify', path: 'verify.awaiting', value: wireCheckpoint.awaiting(identity) },
  { parent: 'verify', path: 'verify.polling', value: wireCheckpoint.polling(identity) },
  { parent: 'verify', path: 'verify.completing', value: wireCheckpoint.completing(completedTurn) },
]
type Checkpoint = (typeof checkpoints)[number]

const encodedCheckpoint = Effect.fn('flowdeck.test.constructNativeCheckpoint')(function* ({
  parent,
  path,
  value,
}: Checkpoint) {
  const { machine } = yield* initialCheckpoint
  const initial = yield* Machine.decodeSnapshot(DevelopmentMachine, machine)
  const encoded = yield* Machine.encodeSnapshot(DevelopmentMachine, initial)
  const before = [...Array.filter(encoded.active, (entry) => String.isEmpty(entry.path)), { path: parent }]
  const wire = (data: WireCheckpoint): typeof encoded => ({ ...encoded, active: [...before, { path, value: data }] })
  return {
    invalidCommand: wire({ ...value, commandId: legacyCommandId }),
    invalidExecution: wire({
      ...value,
      executionId: commandId,
    }),
    valid: wire(value),
  }
})

describe('development native checkpoints', () => {
  live.each(checkpoints)('validates command and execution identities in $path', (checkpoint) =>
    Effect.gen(function* () {
      const { invalidCommand, invalidExecution, valid } = yield* encodedCheckpoint(checkpoint)
      const restored = yield* Machine.decodeSnapshot(DevelopmentMachine, valid)
      expect(yield* Machine.encodeSnapshot(DevelopmentMachine, restored)).toMatchObject({ active: valid.active })

      const badCommand = yield* Effect.flip(Machine.decodeSnapshot(DevelopmentMachine, invalidCommand))
      const badExecution = yield* Effect.flip(Machine.decodeSnapshot(DevelopmentMachine, invalidExecution))
      expect({ command: isDecodeError(badCommand), execution: isDecodeError(badExecution) }).toStrictEqual({
        command: true,
        execution: true,
      })
    }),
  )

  live('round-trips native versions and repository values through both snapshot codecs', () =>
    Effect.gen(function* () {
      const initial = yield* initialCheckpoint
      const encoded = yield* encodeDevelopmentSnapshot(initial)
      yield* decodeWireMetadata(encoded)
      expect({
        context: Predicate.hasProperty(encoded, 'context'),
        nativeSnapshot: isNativeSnapshot(encoded),
      }).toStrictEqual({ context: false, nativeSnapshot: false })

      const decoded = yield* decodeDevelopmentSnapshot(encoded)
      expect(decoded).toStrictEqual(initial)
      const state = yield* Machine.decodeSnapshot(DevelopmentMachine, decoded.machine)
      const root = Option.getOrThrow(DevelopmentStates.get(state, ''))
      expect({
        nativeRepository: root.repository instanceof URL,
        repository: root.repository.href,
        version: root.version,
      }).toStrictEqual({ nativeRepository: true, repository: repositoryUrl, version: developmentVersion })
      expect(yield* Machine.encodeSnapshot(DevelopmentMachine, state)).toStrictEqual(decoded.machine)
    }),
  )
})

describe('development public repository codec', () => {
  live('keeps native URLs in the domain and applies the official wire codec', () =>
    Effect.gen(function* () {
      const repository = yield* decodeRepository('https://GITHUB.COM/example/other/../project')
      expect(repository).toBeInstanceOf(URL)
      expect(repository.href).toBe(repositoryUrl)
      expect(yield* encodeRepository(repository)).toBe(repositoryUrl)
      expect(isRepository(repositoryUrl)).toBe(false)
    }),
  )
})
