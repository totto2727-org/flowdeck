PRAGMA foreign_keys = ON;

CREATE TABLE workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE graphs (
  graph_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json))
);
CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
  version TEXT NOT NULL,
  graph_id TEXT NOT NULL REFERENCES graphs(graph_id),
  PRIMARY KEY (workflow_id, version)
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  graph_id TEXT NOT NULL REFERENCES graphs(graph_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id, workflow_version) REFERENCES workflow_versions(workflow_id, version)
);
CREATE TABLE run_states (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json))
);
CREATE TABLE commit_receipts (
  commit_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  expected_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  first_sequence INTEGER NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  UNIQUE (run_id, revision),
  CHECK (revision = expected_revision + 1)
);
CREATE TABLE run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  commit_id TEXT NOT NULL REFERENCES commit_receipts(commit_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  node_id TEXT,
  execution_id TEXT,
  attempt INTEGER CHECK (attempt IS NULL OR attempt > 0),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);
CREATE INDEX runs_created_at ON runs(created_at DESC, run_id);
CREATE INDEX run_events_run_sequence ON run_events(run_id, sequence);

-- D1 batch is transactional. Failing this first-statement guard rolls back all
-- state/event mutations. Repeating an identical receipt is a committed ACK,
-- including after later revisions. Reusing its ID with different input fails.
CREATE TRIGGER commit_idempotency_guard BEFORE INSERT ON commit_receipts
WHEN EXISTS (
  SELECT 1 FROM commit_receipts
  WHERE commit_id = NEW.commit_id AND command_json <> NEW.command_json
)
BEGIN
  SELECT RAISE(ABORT, 'flowdeck_commit_id_reused');
END;
CREATE TRIGGER commit_revision_guard BEFORE INSERT ON commit_receipts
WHEN NOT EXISTS (SELECT 1 FROM commit_receipts WHERE commit_id = NEW.commit_id)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs JOIN run_states USING (run_id)
    WHERE runs.run_id = NEW.run_id
      AND runs.revision = NEW.expected_revision
      AND run_states.revision = NEW.expected_revision
      AND runs.status NOT IN ('completed', 'failed')
  ) THEN RAISE(ABORT, 'flowdeck_revision_conflict') END;
END;
CREATE TRIGGER graph_identity_guard BEFORE INSERT ON graphs
WHEN EXISTS (SELECT 1 FROM graphs WHERE graph_id = NEW.graph_id AND graph_json <> NEW.graph_json)
BEGIN
  SELECT RAISE(ABORT, 'flowdeck_graph_identity_conflict');
END;
CREATE TRIGGER graph_immutable BEFORE UPDATE ON graphs
BEGIN
  SELECT RAISE(ABORT, 'flowdeck_graph_immutable');
END;
CREATE TRIGGER version_identity_guard BEFORE INSERT ON workflow_versions
WHEN EXISTS (
  SELECT 1 FROM workflow_versions
  WHERE workflow_id = NEW.workflow_id AND version = NEW.version AND graph_id <> NEW.graph_id
)
BEGIN
  SELECT RAISE(ABORT, 'flowdeck_version_identity_conflict');
END;
CREATE TRIGGER version_immutable BEFORE UPDATE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'flowdeck_version_immutable');
END;
