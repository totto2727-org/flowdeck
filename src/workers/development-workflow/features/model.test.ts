import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { DevelopmentSnapshot, DevelopmentSnapshotJson, initialDevelopmentSnapshot } from './development'
import { developmentVersion, PublicRepository } from './input'
import { CommandId, SessionId, TurnReceipt, TurnRequest } from './model'
import { DevelopmentContext, DevelopmentContextJson, PiPhase } from './pi-task'

const decodeNativeDevelopmentContext = Schema.decodeUnknownSync(DevelopmentContext)
const encodeDevelopmentContext = Schema.encodeSync(DevelopmentContextJson)
const decodeDevelopmentContext = Schema.decodeUnknownSync(DevelopmentContextJson)
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

  it.each(['Starting', 'PendingTurn', 'AwaitingTurn', 'Completing'] as const)(
    'requires strict command identities in %s snapshots',
    (_tag) => {
      const phase = {
        _tag,
        sessionId: '1',
        result: 'done',
        commandId,
      }
      const context = { ...decodeDevelopmentContext(initialSnapshot.context), phase }
      expect(Schema.is(PiPhase)(phase)).toBe(true)
      expect(Schema.is(DevelopmentContext)(context)).toBe(true)
      expect(Schema.is(PiPhase)({ ...phase, commandId: 'run:verify:1' })).toBe(false)
      expect(Schema.is(DevelopmentContext)({ ...context, phase: { ...phase, commandId: 'run:verify:1' } })).toBe(false)
      if (_tag !== 'Starting') {
        expect(Schema.is(PiPhase)({ ...phase, sessionId: 'replacement-session' })).toBe(false)
        expect(
          Schema.is(DevelopmentContext)({ ...context, phase: { ...phase, sessionId: 'replacement-session' } }),
        ).toBe(false)
      }
      const snapshot = {
        ...initialSnapshot,
        _tag: 'Running',
        state: 'verify',
        attempt: 1,
        context: encodeDevelopmentContext(decodeNativeDevelopmentContext(context)),
        executionId: 'execution_3d360c7a-4b1a-4df3-9633-861a220bf5b7',
      }
      expect(Schema.is(DevelopmentSnapshot)(snapshot)).toBe(true)
      expect(Schema.is(DevelopmentSnapshot)({ ...snapshot, executionId: commandId })).toBe(false)
    },
  )

  it('round-trips native versions through the snapshot JSON boundary', () => {
    const snapshot = initialSnapshot
    const encoded = encodeDevelopmentSnapshot(snapshot)
    expect(encoded).toMatchObject({
      version: '1.0.0',
      context: { version: '1.0.0', repository: 'https://github.com/example/project' },
    })
    expect(decodeDevelopmentSnapshot(encoded)).toEqual(snapshot)
    const context = decodeDevelopmentContext(snapshot.context)
    expect(context.version).toEqual(developmentVersion)
    expect(context.repository).toBeInstanceOf(URL)
    expect(encodeDevelopmentContext(context)).toEqual(snapshot.context)
    expect(Schema.is(DevelopmentSnapshot)(encoded)).toBe(false)
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
