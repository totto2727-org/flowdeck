import type { D1Database } from '@cloudflare/workers-types'
import { live } from '@effect/vitest'
import { Array, Effect } from 'effect'
import { describe, expect } from 'vite-plus/test'

import { openD1WorkflowTestDatabase } from './integration/d1-workflow-database.fixture.ts'

const seed = [
  "INSERT INTO workflows VALUES ('workflow', 'Workflow')",
  "INSERT INTO graphs VALUES ('graph', 1, '{}')",
  "INSERT INTO workflow_versions VALUES ('workflow', '1.0.0', 'graph')",
  "INSERT INTO runs VALUES ('run', 'workflow', '1.0.0', 'graph', 'pending', 0, 0, '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z')",
  "INSERT INTO run_states VALUES ('run', 0, '{}')",
  "INSERT INTO commit_receipts VALUES ('commit', 'run', 0, 1, 1, 1, '{}')",
  "INSERT INTO run_events VALUES ('event', 'run', 'commit', 1, NULL, NULL, NULL, 'run.started', '{}', '2026-11-03T00:00:00Z')",
]

const nullIdentityCases = [
  ['workflows.workflow_id', "INSERT INTO workflows VALUES (NULL, 'Workflow')"],
  ['graphs.graph_id', "INSERT INTO graphs VALUES (NULL, 1, '{}')"],
  ['workflow_versions.workflow_id', "INSERT INTO workflow_versions VALUES (NULL, '2.0.0', 'graph')"],
  ['workflow_versions.version', "INSERT INTO workflow_versions VALUES ('workflow', NULL, 'graph')"],
  [
    'runs.run_id',
    "INSERT INTO runs VALUES (NULL, 'workflow', '1.0.0', 'graph', 'pending', 0, 0, '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z')",
  ],
  ['run_states.run_id', "INSERT INTO run_states VALUES (NULL, 0, '{}')"],
  ['commit_receipts.commit_id', "INSERT INTO commit_receipts VALUES (NULL, 'run', 0, 1, 1, 1, '{}')"],
  [
    'run_events.event_id',
    "INSERT INTO run_events VALUES (NULL, 'run', 'commit', 2, NULL, NULL, NULL, 'run.started', '{}', '2026-11-03T00:00:00Z')",
  ],
] as const

const schemaDatabase = Effect.gen(function* () {
  const { database } = yield* openD1WorkflowTestDatabase
  const statements = Array.map(seed, (sql) => database.prepare(sql))
  yield* Effect.promise(async () => database.batch(statements))
  return database
})

const expectRejection = (database: D1Database, sql: string, message: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await expect(database.prepare(sql).run()).rejects.toThrow(message)
  })

describe('generated D1 schema identity constraints', () => {
  live.each(nullIdentityCases)('rejects NULL identity in %s', ([column, query]) =>
    Effect.gen(function* () {
      const database = yield* schemaDatabase
      yield* expectRejection(database, query, `NOT NULL constraint failed: ${column}`)
    }),
  )

  live('rejects an unsupported graph schema version', () =>
    Effect.gen(function* () {
      const database = yield* schemaDatabase
      yield* expectRejection(
        database,
        "INSERT INTO graphs VALUES ('other', 2, '{}')",
        'CHECK constraint failed: schema_version = 1',
      )
    }),
  )
})

describe('generated D1 schema uniqueness constraints', () => {
  live('rejects duplicate receipt revisions', () =>
    Effect.gen(function* () {
      const database = yield* schemaDatabase
      yield* expectRejection(
        database,
        "INSERT INTO commit_receipts VALUES ('other', 'run', 0, 1, 1, 1, '{}')",
        'UNIQUE constraint failed: commit_receipts.run_id, commit_receipts.revision',
      )
    }),
  )

  live('rejects duplicate event sequences', () =>
    Effect.gen(function* () {
      const database = yield* schemaDatabase
      yield* expectRejection(
        database,
        "INSERT INTO run_events VALUES ('other', 'run', 'commit', 1, NULL, NULL, NULL, 'run.started', '{}', '2026-11-03T00:00:00Z')",
        'UNIQUE constraint failed: run_events.run_id, run_events.sequence',
      )
    }),
  )
})

describe('generated D1 schema Cluster constraints', () => {
  live('rejects invalid JSON in a Cluster machine checkpoint', () =>
    Effect.gen(function* () {
      const database = yield* schemaDatabase
      yield* expectRejection(
        database,
        "INSERT INTO cluster_machine_checkpoints VALUES ('default', 1, 'machine', 'entity', 'id', '1', '1', 'invalid')",
        'CHECK constraint failed: json_valid(snapshot_json)',
      )
    }),
  )

  live('rejects a Cluster request receipt without its full checkpoint address', () =>
    Effect.gen(function* () {
      const database = yield* schemaDatabase
      yield* expectRejection(
        database,
        "INSERT INTO cluster_machine_requests VALUES ('default', 1, 'machine', 'entity', '1')",
        'FOREIGN KEY constraint failed',
      )
    }),
  )
})
