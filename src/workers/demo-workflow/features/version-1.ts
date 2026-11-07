import { Effect } from 'effect'

import type { GraphDefinition } from '../../../features/workflow/domain/model'
import { demoVersion1 } from './input'

export const demoVersion1Definition = {
  version: demoVersion1,
  graph: {
    graphId: 'demo-1_0_0-graph-1',
    schemaVersion: 1,
    nodes: [
      { nodeId: 'prepare', label: 'Prepare release', kind: 'task' },
      { nodeId: 'approval', label: 'Manual approval', kind: 'checkpoint' },
      { nodeId: 'publish', label: 'Publish release', kind: 'task' },
    ],
    edges: [
      { edgeId: 'prepare-approval', source: 'prepare', target: 'approval', label: 'prepared' },
      { edgeId: 'approval-publish', source: 'approval', target: 'publish', label: 'resume' },
    ],
  } satisfies GraphDefinition,
  prepare: Effect.succeed('draft:v1'),
}
