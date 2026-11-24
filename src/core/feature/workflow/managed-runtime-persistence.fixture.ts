import { Array, Data, DateTime, Effect, MutableRef, SemVer } from 'effect'

import type { GraphDefinition, Run } from '@/core/feature/workflow/domain/model'

import { runId } from './managed-runtime-observers.fixture.ts'
import { encodeManagedSnapshot } from './managed-runtime.ts'
import type { CommitCommand, StoreFailure, StoreService } from './services/store.ts'

export const version = SemVer.parseUnsafe('1.0.0')
export const graph: GraphDefinition = { edges: [], graphId: 'managed-test-1', nodes: [], schemaVersion: 1 }

const initialRevision = 0
const revisionIncrement = 1
const earliestEventSequence = 1
const timestamp = DateTime.makeUnsafe('2026-11-01T00:00:00Z')
export const workflowId = 'managed-test'

const makeRun = (machine: Run['snapshot']): Run => ({
  createdAt: timestamp,
  graphId: graph.graphId,
  revision: initialRevision,
  runId,
  snapshot: encodeManagedSnapshot({ machine, schemaVersion: 1, version }),
  status: 'pending',
  updatedAt: timestamp,
  workflowId,
  workflowVersion: version,
})

type BeforeCommit = (command: CommitCommand) => Effect.Effect<void, StoreFailure>
type StoreState = Readonly<{ beforeCommit: BeforeCommit; commits: Readonly<CommitCommand[]>; run: Run }>
type StoreRef = MutableRef.MutableRef<StoreState>
type PersistenceFixture = Readonly<{
  beforeCommit: (callback: BeforeCommit) => void
  commits: () => StoreState['commits']
  current: () => Run
  replace: (run: Run) => void
  store: StoreService
}>

class UnexpectedRevision extends Data.TaggedError('UnexpectedRevision')<{ actual: number; expected: number }> {}

const applyCommit = (run: Run, command: CommitCommand): Run => ({
  ...run,
  revision: run.revision + revisionIncrement,
  snapshot: command.snapshot,
  status: command.status,
  updatedAt: command.updatedAt,
})

const commitTo = (state: StoreRef): StoreService['commit'] =>
  Effect.fn('flowdeck.test.commitManagedFixture')(function* (command) {
    yield* MutableRef.get(state).beforeCommit(command)
    const { run: saved } = MutableRef.get(state)
    if (command.expectedRevision !== saved.revision) {
      return yield* Effect.die(new UnexpectedRevision({ actual: saved.revision, expected: command.expectedRevision }))
    }
    const run = applyCommit(saved, command)
    MutableRef.update(state, (previous) => ({ ...previous, commits: Array.append(previous.commits, command), run }))
    return {
      commitId: command.commitId,
      eventCount: command.events.length,
      firstSequence: earliestEventSequence,
      revision: run.revision,
      runId,
    }
  })

export const makeManagedPersistence = (machine: Run['snapshot']): PersistenceFixture => {
  const state = MutableRef.make<StoreState>({ beforeCommit: () => Effect.void, commits: [], run: makeRun(machine) })
  const current = (): Run => MutableRef.get(state).run
  const store: StoreService = {
    commit: commitTo(state),
    create: () => Effect.void,
    getEvents: () => Effect.succeed([]),
    getGraph: () => Effect.succeed(graph),
    getRun: () => Effect.sync(current),
    listRuns: Effect.sync(() => [current()]),
  }
  return {
    beforeCommit: (guard) => {
      MutableRef.update(state, (previous) => ({ ...previous, beforeCommit: guard }))
    },
    commits: () => MutableRef.get(state).commits,
    current,
    replace: (run) => {
      MutableRef.update(state, (previous) => ({ ...previous, run }))
    },
    store,
  }
}
