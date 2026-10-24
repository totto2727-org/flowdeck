-- Forward-only strengthening of immutable run/version/graph identity.
-- Existing run tables stay in place, preserving all local execution history.
CREATE TRIGGER run_version_graph_guard BEFORE INSERT ON runs
WHEN NOT EXISTS (
  SELECT 1 FROM workflow_versions
  WHERE workflow_id = NEW.workflow_id
    AND version = NEW.workflow_version
    AND graph_id = NEW.graph_id
)
BEGIN
  SELECT RAISE(ABORT, 'flowdeck_run_version_graph_conflict');
END;
CREATE TRIGGER run_identity_immutable
BEFORE UPDATE OF run_id, workflow_id, workflow_version, graph_id ON runs
BEGIN
  SELECT RAISE(ABORT, 'flowdeck_run_identity_immutable');
END;
