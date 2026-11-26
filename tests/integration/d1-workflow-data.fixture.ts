import { DateTime, Effect, SemVer } from 'effect'

import type { Run, WorkflowVersion } from '@/core/feature/workflow/domain/model'
import type { CommitCommand, StoreService } from '@/core/feature/workflow/services/store'
import { demoDefinition } from '@/user-land/workflow/demo/feature/definition'
import { demoGraph, encodeDemoSnapshot, initialSnapshot } from '@/user-land/workflow/demo/feature/demo'

export const version1 = SemVer.parseUnsafe('1.0.0')
export const version2 = SemVer.parseUnsafe('2.0.0')
export const now = DateTime.makeUnsafe('2026-10-17T12:00:00.000Z')
export const primaryGraph = demoGraph(version1)
export const demoWorkflowName = demoDefinition.summary.name
export const defaultRunId = 'run_00000000-0000-4000-8000-000000000001'

export const newRun = (runId: string, version: WorkflowVersion = version1): Effect.Effect<Run> =>
  Effect.gen(function* () {
    const initial = yield* initialSnapshot(version)
    const snapshot = yield* encodeDemoSnapshot(initial)
    return {
      createdAt: now,
      graphId: demoGraph(version).graphId,
      revision: 0,
      runId,
      snapshot,
      status: 'pending',
      updatedAt: now,
      workflowId: 'demo',
      workflowVersion: version,
    }
  })

export const command = (overrides: Partial<CommitCommand> = {}): CommitCommand => ({
  commitId: 'commit_00000000-0000-4000-8000-000000000001',
  events: [
    {
      attempt: 1,
      createdAt: now,
      eventId: 'event_00000000-0000-4000-8000-000000000001',
      executionId: 'execution_00000000-0000-4000-8000-000000000001',
      nodeId: 'prepare',
      payload: {},
      type: 'node.started',
    },
  ],
  expectedRevision: 0,
  runId: defaultRunId,
  snapshot: { checkpoint: 'running-store-write' },
  status: 'running',
  updatedAt: now,
  ...overrides,
})

export const seed = (
  store: StoreService,
  runId: string,
  version: WorkflowVersion,
): ReturnType<StoreService['create']> =>
  Effect.gen(function* () {
    const run = yield* newRun(runId, version)
    return yield* store.create(run, demoGraph(version), demoDefinition.summary.name)
  })
