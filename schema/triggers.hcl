trigger "graph_identity_guard" {
  on = table.graphs
  before {
    insert = true
  }
  when = "EXISTS (SELECT 1 FROM graphs WHERE graph_id = NEW.graph_id AND graph_json <> NEW.graph_json)"
  as   = <<-SQL
  BEGIN
    SELECT RAISE(ABORT, 'flowdeck_graph_identity_conflict');
  END
  SQL
}
trigger "graph_immutable" {
  on = table.graphs
  before {
    update = true
  }
  as = <<-SQL
  BEGIN
    SELECT RAISE(ABORT, 'flowdeck_graph_immutable');
  END
  SQL
}
trigger "version_identity_guard" {
  on = table.workflow_versions
  before {
    insert = true
  }
  when = "EXISTS (\n  SELECT 1 FROM workflow_versions\n  WHERE workflow_id = NEW.workflow_id AND version = NEW.version AND graph_id <> NEW.graph_id\n)"
  as   = <<-SQL
  BEGIN
    SELECT RAISE(ABORT, 'flowdeck_version_identity_conflict');
  END
  SQL
}
trigger "version_immutable" {
  on = table.workflow_versions
  before {
    update = true
  }
  as = <<-SQL
  BEGIN
    SELECT RAISE(ABORT, 'flowdeck_version_immutable');
  END
  SQL
}
trigger "run_version_graph_guard" {
  on = table.runs
  before {
    insert = true
  }
  when = "NOT EXISTS (\n  SELECT 1 FROM workflow_versions\n  WHERE workflow_id = NEW.workflow_id\n    AND version = NEW.workflow_version\n    AND graph_id = NEW.graph_id\n)"
  as   = <<-SQL
  BEGIN
    SELECT RAISE(ABORT, 'flowdeck_run_version_graph_conflict');
  END
  SQL
}
trigger "run_identity_immutable" {
  on = table.runs
  before {
    update_of = [table.runs.column.run_id, table.runs.column.workflow_id, table.runs.column.workflow_version, table.runs.column.graph_id]
  }
  as = <<-SQL
  BEGIN
    SELECT RAISE(ABORT, 'flowdeck_run_identity_immutable');
  END
  SQL
}
trigger "commit_idempotency_guard" {
  on = table.commit_receipts
  before {
    insert = true
  }
  when = "EXISTS (\n  SELECT 1 FROM commit_receipts\n  WHERE commit_id = NEW.commit_id AND command_json <> NEW.command_json\n)"
  as   = <<-SQL
  BEGIN
    SELECT RAISE(ABORT, 'flowdeck_commit_id_reused');
  END
  SQL
}
trigger "commit_revision_guard" {
  on = table.commit_receipts
  before {
    insert = true
  }
  when = "NOT EXISTS (SELECT 1 FROM commit_receipts WHERE commit_id = NEW.commit_id)"
  as   = <<-SQL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM runs JOIN run_states USING (run_id)
      WHERE runs.run_id = NEW.run_id
        AND runs.revision = NEW.expected_revision
        AND run_states.revision = NEW.expected_revision
        AND runs.status NOT IN ('completed', 'failed')
    ) THEN RAISE(ABORT, 'flowdeck_revision_conflict') END;
  END
  SQL
}
