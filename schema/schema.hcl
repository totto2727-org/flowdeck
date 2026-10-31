// Tables, checks, foreign keys, and indexes mirror migrations/0001 and 0002.
// SQLite TEXT PRIMARY KEY columns remain nullable here to preserve zero drift.
// Do not strengthen nullability without a new, reviewed SQL migration.
// Atlas Community does not inspect or manage triggers.
// All eight transactional and identity guards remain in the versioned SQL migrations.
// Reylo reads this HCL directly for local query analysis without a database file.
// Runtime databases must apply migrations, including their triggers.
// Atlas v1.1.3 canary normalizes implicit UNIQUE indexes into named indexes.
// Its migration diff currently proposes redundant index replacements against
// the original SQL constraints. Do not apply that generated plan unchanged.

table "workflows" {
  schema = schema.main
  column "workflow_id" {
    null = true
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
    null = true
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
    null = true
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
    null = true
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
    null = true
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
  index "sqlite_autoindex_commit_receipts_2" {
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
    null = true
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
    null = true
    type = text
  }
  column "execution_id" {
    null = true
    type = text
  }
  column "attempt" {
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
  index "sqlite_autoindex_run_events_2" {
    unique  = true
    columns = [column.run_id, column.sequence]
  }
  index "run_events_run_sequence" {
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
schema "main" {
}
