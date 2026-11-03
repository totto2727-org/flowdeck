import { readD1Migrations } from '@cloudflare/vitest-plugin'
import type { D1Database } from '@cloudflare/workers-types'
import { Array } from 'effect'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

let miniflare: Miniflare
let database: D1Database

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'schema-test' },
  })
  database = await miniflare.getD1Database('DB')
  const migrations = await readD1Migrations('migrations')
  await database.batch(
    Array.map(
      Array.flatMap(migrations, (migration) => migration.queries),
      (query) => database.prepare(query),
    ),
  )
  await database.batch(
    Array.map(
      [
        "INSERT INTO workflows VALUES ('workflow', 'Workflow')",
        "INSERT INTO graphs VALUES ('graph', 1, '{}')",
        "INSERT INTO workflow_versions VALUES ('workflow', '1.0.0', 'graph')",
        "INSERT INTO runs VALUES ('run', 'workflow', '1.0.0', 'graph', 'pending', 0, 0, '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z')",
        "INSERT INTO run_states VALUES ('run', 0, '{}')",
        "INSERT INTO commit_receipts VALUES ('commit', 'run', 0, 1, 1, 1, '{}')",
        "INSERT INTO run_events VALUES ('event', 'run', 'commit', 1, NULL, NULL, NULL, 'run.started', '{}', '2026-11-03T00:00:00Z')",
      ],
      (query) => database.prepare(query),
    ),
  )
})

afterEach(async () => {
  await miniflare.dispose()
})

describe('generated D1 schema', () => {
  it.each([
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
  ])('rejects NULL identity in %s', async (column, query) => {
    await expect(database.prepare(query).run()).rejects.toThrow(`NOT NULL constraint failed: ${column}`)
  })

  it('rejects an unsupported graph schema version', async () => {
    await expect(database.prepare("INSERT INTO graphs VALUES ('other', 2, '{}')").run()).rejects.toThrow(
      'CHECK constraint failed: schema_version = 1',
    )
  })

  it('rejects duplicate receipt revisions', async () => {
    await expect(
      database.prepare("INSERT INTO commit_receipts VALUES ('other', 'run', 0, 1, 1, 1, '{}')").run(),
    ).rejects.toThrow('UNIQUE constraint failed: commit_receipts.run_id, commit_receipts.revision')
  })

  it('rejects duplicate event sequences', async () => {
    await expect(
      database
        .prepare(
          "INSERT INTO run_events VALUES ('other', 'run', 'commit', 1, NULL, NULL, NULL, 'run.started', '{}', '2026-11-03T00:00:00Z')",
        )
        .run(),
    ).rejects.toThrow('UNIQUE constraint failed: run_events.run_id, run_events.sequence')
  })
})
