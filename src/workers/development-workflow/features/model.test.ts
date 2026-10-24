import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CommandId, TurnReceipt, TurnRequest } from './model'

const commandId = '3d360c7a-4b1a-4df3-9633-861a220bf5b7'

describe('development operation wire schemas', () => {
  it('accepts UUIDv4 operation identities through the standard Schema check', () => {
    expect(Schema.decodeUnknownSync(CommandId)(commandId)).toBe(commandId)
    expect(Schema.decodeUnknownSync(TurnRequest)({ commandId, prompt: 'Verify the change.' })).toEqual({
      commandId,
      prompt: 'Verify the change.',
    })
  })

  it.each(['run:implement:1', 'not-a-uuid', '3d360c7a-4b1a-1df3-9633-861a220bf5b7'])(
    'rejects non-v4 new operation identity %s',
    (invalid) => {
      expect(() => Schema.decodeUnknownSync(CommandId)(invalid)).toThrow()
    },
  )

  it('keeps receipts from legacy operation histories inspectable', () => {
    const receipt = { commandId: 'old-run:verify:1', status: 'completed', text: 'done' }
    expect(Schema.decodeUnknownSync(TurnReceipt)(receipt)).toEqual(receipt)
  })
})
