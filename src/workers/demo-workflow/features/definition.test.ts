import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { demoDefinition } from './definition'
import { demoGraph, initialSnapshot } from './demo'

describe('demo definition', () => {
  it.each(['1.0.0', '2.0.0'])('prepares the selected implementation %s', async (version) => {
    expect(await Effect.runPromise(demoDefinition.prepare({ workflowId: 'demo', version }))).toEqual({
      graph: demoGraph(version),
      snapshot: initialSnapshot(version),
    })
  })

  it.each([
    { workflowId: 'demo', version: 'v1' },
    { workflowId: 'demo', version: '3.0.0' },
    { workflowId: 'demo', version: '1.0.0', task: 'unexpected' },
    { workflowId: 'other', version: '1.0.0' },
  ])('rejects unsupported or excess input %j', async (input) => {
    await expect(Effect.runPromise(demoDefinition.prepare(input))).rejects.toThrow()
  })
})
