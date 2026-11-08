import { Effect } from 'effect'

import type { GraphDefinition } from '@/features/workflow/domain/model'

import { demoVersion2 } from './input'

export const demoVersion2Definition = {
  version: demoVersion2,
  graph: {
    graphId: 'demo-2_0_0-graph-1',
    schemaVersion: 1,
    nodes: [
      { nodeId: 'prepare', label: 'Enrich release', kind: 'task' },
      { nodeId: 'approval', label: 'Manual approval', kind: 'checkpoint' },
      { nodeId: 'publish', label: 'Publish enriched release', kind: 'task' },
    ],
    edges: [
      { edgeId: 'prepare-approval', source: 'prepare', target: 'approval', label: 'prepared' },
      { edgeId: 'approval-publish', source: 'approval', target: 'publish', label: 'resume' },
    ],
  } satisfies GraphDefinition,
  prepare: Effect.succeed('draft:v2:reviewed'),
}
