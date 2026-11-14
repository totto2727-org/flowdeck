table "workflows" {
  schema = schema.main
  column "workflow_id" {
    null = false
    type = text
  }
  column "name" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.workflow_id]
  }
}
table "graphs" {
  schema = schema.main
  column "graph_id" {
    null = false
    type = text
  }
  column "schema_version" {
    null = false
    type = integer
  }
  column "graph_json" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.graph_id]
  }
  check {
    expr = "(schema_version = 1)"
  }
  check {
    expr = "(json_valid(graph_json))"
  }
}
table "workflow_versions" {
  schema = schema.main
  column "workflow_id" {
    null = false
    type = text
  }
  column "version" {
    null = false
    type = text
  }
  column "graph_id" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.workflow_id, column.version]
  }
  foreign_key "0" {
    columns     = [column.graph_id]
    ref_columns = [table.graphs.column.graph_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "1" {
    columns     = [column.workflow_id]
    ref_columns = [table.workflows.column.workflow_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
}
table "runs" {
  schema = schema.main
  column "run_id" {
    null = false
    type = text
  }
  column "workflow_id" {
    null = false
    type = text
  }
  column "workflow_version" {
    null = false
    type = text
  }
  column "graph_id" {
    null = false
    type = text
  }
  column "status" {
    null = false
    type = text
  }
  column "revision" {
    null = false
    type = integer
  }
  column "last_sequence" {
    null    = false
    type    = integer
    default = 0
  }
  column "created_at" {
    null = false
    type = text
  }
  column "updated_at" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.run_id]
  }
  foreign_key "0" {
    columns     = [column.workflow_id, column.workflow_version]
    ref_columns = [table.workflow_versions.column.workflow_id, table.workflow_versions.column.version]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "1" {
    columns     = [column.graph_id]
    ref_columns = [table.graphs.column.graph_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  index "runs_created_at" {
    on {
      desc   = true
      column = column.created_at
    }
    on {
      column = column.run_id
    }
  }
  check {
    expr = "(status IN ('pending', 'running', 'waiting', 'completed', 'failed'))"
  }
  check {
    expr = "(revision >= 0)"
  }
  check {
    expr = "(last_sequence >= 0)"
  }
}
table "run_states" {
  schema = schema.main
  column "run_id" {
    null = false
    type = text
  }
  column "revision" {
    null = false
    type = integer
  }
  column "snapshot_json" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.run_id]
  }
  foreign_key "0" {
    columns     = [column.run_id]
    ref_columns = [table.runs.column.run_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  check {
    expr = "(revision >= 0)"
  }
  check {
    expr = "(json_valid(snapshot_json))"
  }
}
table "commit_receipts" {
  schema = schema.main
  column "commit_id" {
    null = false
    type = text
  }
  column "run_id" {
    null = false
    type = text
  }
  column "expected_revision" {
    null = false
    type = integer
  }
  column "revision" {
    null = false
    type = integer
  }
  column "first_sequence" {
    null = false
    type = integer
  }
  column "event_count" {
    null = false
    type = integer
  }
  column "command_json" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.commit_id]
  }
  foreign_key "0" {
    columns     = [column.run_id]
    ref_columns = [table.runs.column.run_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  index "commit_receipts_run_revision" {
    unique  = true
    columns = [column.run_id, column.revision]
  }
  check {
    expr = "(event_count >= 0)"
  }
  check {
    expr = "(json_valid(command_json))"
  }
  check {
    expr = "(revision = expected_revision + 1)"
  }
}
table "run_events" {
  schema = schema.main
  column "event_id" {
    null = false
    type = text
  }
  column "run_id" {
    null = false
    type = text
  }
  column "commit_id" {
    null = false
    type = text
  }
  column "sequence" {
    null = false
    type = integer
  }
  column "node_id" {
    // Run start, resume, completion, and failure events are not tied to a node.
    null = true
    type = text
  }
  column "execution_id" {
    // Events without a node do not identify a node execution.
    null = true
    type = text
  }
  column "attempt" {
    // Events without a node execution have no execution attempt number.
    null = true
    type = integer
  }
  column "type" {
    null = false
    type = text
  }
  column "payload_json" {
    null = false
    type = text
  }
  column "created_at" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.event_id]
  }
  foreign_key "0" {
    columns     = [column.commit_id]
    ref_columns = [table.commit_receipts.column.commit_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  foreign_key "1" {
    columns     = [column.run_id]
    ref_columns = [table.runs.column.run_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
  index "run_events_run_sequence" {
    unique  = true
    columns = [column.run_id, column.sequence]
  }
  check {
    expr = "(sequence > 0)"
  }
  check {
    expr = "(attempt IS NULL OR attempt > 0)"
  }
  check {
    expr = "(json_valid(payload_json))"
  }
}
table "cluster_machine_checkpoints" {
  schema = schema.main
  column "shard_group" {
    null = false
    type = text
  }
  column "shard_id" {
    null = false
    type = integer
  }
  column "entity_type" {
    null = false
    type = text
  }
  column "entity_id" {
    null = false
    type = text
  }
  column "machine_id" {
    null = false
    type = text
  }
  column "version" {
    null = false
    type = text
  }
  column "request_id" {
    null = false
    type = text
  }
  column "snapshot_json" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.shard_group, column.shard_id, column.entity_type, column.entity_id]
  }
  check {
    expr = "(json_valid(snapshot_json))"
  }
}
table "cluster_machine_requests" {
  schema = schema.main
  column "shard_group" {
    null = false
    type = text
  }
  column "shard_id" {
    null = false
    type = integer
  }
  column "entity_type" {
    null = false
    type = text
  }
  column "entity_id" {
    null = false
    type = text
  }
  column "request_id" {
    null = false
    type = text
  }
  primary_key {
    columns = [column.shard_group, column.shard_id, column.entity_type, column.entity_id, column.request_id]
  }
  foreign_key "cluster_machine_requests_checkpoint" {
    columns     = [column.shard_group, column.shard_id, column.entity_type, column.entity_id]
    ref_columns = [table.cluster_machine_checkpoints.column.shard_group, table.cluster_machine_checkpoints.column.shard_id, table.cluster_machine_checkpoints.column.entity_type, table.cluster_machine_checkpoints.column.entity_id]
    on_update   = NO_ACTION
    on_delete   = NO_ACTION
  }
}
schema "main" {
}
