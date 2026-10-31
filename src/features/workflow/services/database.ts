import type { Generated } from 'kysely'

import type { CommitId, EventId, ExecutionId, GraphId, NodeId, RunId, WorkflowId } from '../domain/identity'

export interface Database {
  workflows: { workflow_id: WorkflowId; name: string }
  graphs: { graph_id: GraphId; schema_version: number; graph_json: string }
  workflow_versions: { workflow_id: WorkflowId; version: string; graph_id: GraphId }
  runs: {
    run_id: RunId
    workflow_id: WorkflowId
    workflow_version: string
    graph_id: GraphId
    status: string
    revision: number
    last_sequence: Generated<number>
    created_at: string
    updated_at: string
  }
  run_states: { run_id: RunId; revision: number; snapshot_json: string }
  commit_receipts: {
    commit_id: CommitId
    run_id: RunId
    expected_revision: number
    revision: number
    first_sequence: number
    event_count: number
    command_json: string
  }
  run_events: {
    event_id: EventId
    run_id: RunId
    commit_id: CommitId
    sequence: number
    node_id: NodeId | null
    execution_id: ExecutionId | null
    attempt: number | null
    type: string
    payload_json: string
    created_at: string
  }
}
