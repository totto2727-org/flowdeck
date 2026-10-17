import type { Generated } from 'kysely'

export interface Database {
  workflows: { workflow_id: string; name: string }
  graphs: { graph_id: string; schema_version: number; graph_json: string }
  workflow_versions: { workflow_id: string; version: string; graph_id: string }
  runs: {
    run_id: string
    workflow_id: string
    workflow_version: string
    graph_id: string
    status: string
    revision: number
    last_sequence: Generated<number>
    created_at: string
    updated_at: string
  }
  run_states: { run_id: string; revision: number; snapshot_json: string }
  commit_receipts: {
    commit_id: string
    run_id: string
    expected_revision: number
    revision: number
    first_sequence: number
    event_count: number
    command_json: string
  }
  run_events: {
    event_id: string
    run_id: string
    commit_id: string
    sequence: number
    node_id: string | null
    execution_id: string | null
    attempt: number | null
    type: string
    payload_json: string
    created_at: string
  }
}
