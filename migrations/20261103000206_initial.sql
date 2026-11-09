-- Create "workflows" table
CREATE TABLE `workflows` (
  `workflow_id` text NOT NULL,
  `name` text NOT NULL,
  PRIMARY KEY (`workflow_id`)
);
-- Create "graphs" table
CREATE TABLE `graphs` (
  `graph_id` text NOT NULL,
  `schema_version` integer NOT NULL,
  `graph_json` text NOT NULL,
  PRIMARY KEY (`graph_id`),
  CHECK (schema_version = 1),
  CHECK (json_valid(graph_json))
);
-- Create trigger "graph_identity_guard"
CREATE TRIGGER `graph_identity_guard` BEFORE INSERT ON `graphs` FOR EACH ROW WHEN EXISTS (SELECT 1 FROM graphs WHERE graph_id = NEW.graph_id AND graph_json <> NEW.graph_json) BEGIN
  SELECT RAISE(ABORT, 'flowdeck_graph_identity_conflict');
END;
-- Create trigger "graph_immutable"
CREATE TRIGGER `graph_immutable` BEFORE UPDATE ON `graphs` FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'flowdeck_graph_immutable');
END;
-- Create "workflow_versions" table
CREATE TABLE `workflow_versions` (
  `workflow_id` text NOT NULL,
  `version` text NOT NULL,
  `graph_id` text NOT NULL,
  PRIMARY KEY (`workflow_id`, `version`),
  CONSTRAINT `0` FOREIGN KEY (`graph_id`) REFERENCES `graphs` (`graph_id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT `1` FOREIGN KEY (`workflow_id`) REFERENCES `workflows` (`workflow_id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create trigger "version_identity_guard"
CREATE TRIGGER `version_identity_guard` BEFORE INSERT ON `workflow_versions` FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM workflow_versions
  WHERE workflow_id = NEW.workflow_id AND version = NEW.version AND graph_id <> NEW.graph_id
) BEGIN
  SELECT RAISE(ABORT, 'flowdeck_version_identity_conflict');
END;
-- Create trigger "version_immutable"
CREATE TRIGGER `version_immutable` BEFORE UPDATE ON `workflow_versions` FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'flowdeck_version_immutable');
END;
-- Create "runs" table
CREATE TABLE `runs` (
  `run_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `workflow_version` text NOT NULL,
  `graph_id` text NOT NULL,
  `status` text NOT NULL,
  `revision` integer NOT NULL,
  `last_sequence` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`run_id`),
  CONSTRAINT `0` FOREIGN KEY (`workflow_id`, `workflow_version`) REFERENCES `workflow_versions` (`workflow_id`, `version`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT `1` FOREIGN KEY (`graph_id`) REFERENCES `graphs` (`graph_id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed')),
  CHECK (revision >= 0),
  CHECK (last_sequence >= 0)
);
-- Create index "runs_created_at" to table: "runs"
CREATE INDEX `runs_created_at` ON `runs` (`created_at` DESC, `run_id`);
-- Create trigger "run_version_graph_guard"
CREATE TRIGGER `run_version_graph_guard` BEFORE INSERT ON `runs` FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM workflow_versions
  WHERE workflow_id = NEW.workflow_id
    AND version = NEW.workflow_version
    AND graph_id = NEW.graph_id
) BEGIN
  SELECT RAISE(ABORT, 'flowdeck_run_version_graph_conflict');
END;
-- Create trigger "run_identity_immutable"
CREATE TRIGGER `run_identity_immutable` BEFORE UPDATE OF `run_id`, `workflow_id`, `workflow_version`, `graph_id` ON `runs` FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'flowdeck_run_identity_immutable');
END;
-- Create "run_states" table
CREATE TABLE `run_states` (
  `run_id` text NOT NULL,
  `revision` integer NOT NULL,
  `snapshot_json` text NOT NULL,
  PRIMARY KEY (`run_id`),
  CONSTRAINT `0` FOREIGN KEY (`run_id`) REFERENCES `runs` (`run_id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CHECK (revision >= 0),
  CHECK (json_valid(snapshot_json))
);
-- Create "commit_receipts" table
CREATE TABLE `commit_receipts` (
  `commit_id` text NOT NULL,
  `run_id` text NOT NULL,
  `expected_revision` integer NOT NULL,
  `revision` integer NOT NULL,
  `first_sequence` integer NOT NULL,
  `event_count` integer NOT NULL,
  `command_json` text NOT NULL,
  PRIMARY KEY (`commit_id`),
  CONSTRAINT `0` FOREIGN KEY (`run_id`) REFERENCES `runs` (`run_id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CHECK (event_count >= 0),
  CHECK (json_valid(command_json)),
  CHECK (revision = expected_revision + 1)
);
-- Create index "commit_receipts_run_revision" to table: "commit_receipts"
CREATE UNIQUE INDEX `commit_receipts_run_revision` ON `commit_receipts` (`run_id`, `revision`);
-- Create trigger "commit_idempotency_guard"
CREATE TRIGGER `commit_idempotency_guard` BEFORE INSERT ON `commit_receipts` FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM commit_receipts
  WHERE commit_id = NEW.commit_id AND command_json <> NEW.command_json
) BEGIN
  SELECT RAISE(ABORT, 'flowdeck_commit_id_reused');
END;
-- Create trigger "commit_revision_guard"
CREATE TRIGGER `commit_revision_guard` BEFORE INSERT ON `commit_receipts` FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM commit_receipts WHERE commit_id = NEW.commit_id) BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM runs JOIN run_states USING (run_id)
    WHERE runs.run_id = NEW.run_id
      AND runs.revision = NEW.expected_revision
      AND run_states.revision = NEW.expected_revision
      AND runs.status NOT IN ('completed', 'failed')
  ) THEN RAISE(ABORT, 'flowdeck_revision_conflict') END;
END;
-- Create "run_events" table
CREATE TABLE `run_events` (
  `event_id` text NOT NULL,
  `run_id` text NOT NULL,
  `commit_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `node_id` text NULL,
  `execution_id` text NULL,
  `attempt` integer NULL,
  `type` text NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`event_id`),
  CONSTRAINT `0` FOREIGN KEY (`commit_id`) REFERENCES `commit_receipts` (`commit_id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT `1` FOREIGN KEY (`run_id`) REFERENCES `runs` (`run_id`) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CHECK (sequence > 0),
  CHECK (attempt IS NULL OR attempt > 0),
  CHECK (json_valid(payload_json))
);
-- Create index "run_events_run_sequence" to table: "run_events"
CREATE UNIQUE INDEX `run_events_run_sequence` ON `run_events` (`run_id`, `sequence`);
-- Create "cluster_machine_checkpoints" table
CREATE TABLE `cluster_machine_checkpoints` (
  `shard_group` text NOT NULL,
  `shard_id` integer NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `machine_id` text NOT NULL,
  `version` text NOT NULL,
  `request_id` text NOT NULL,
  `snapshot_json` text NOT NULL,
  PRIMARY KEY (`shard_group`, `shard_id`, `entity_type`, `entity_id`),
  CHECK (json_valid(snapshot_json))
);
-- Create "cluster_machine_requests" table
CREATE TABLE `cluster_machine_requests` (
  `shard_group` text NOT NULL,
  `shard_id` integer NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` text NOT NULL,
  `request_id` text NOT NULL,
  PRIMARY KEY (`shard_group`, `shard_id`, `entity_type`, `entity_id`, `request_id`),
  CONSTRAINT `cluster_machine_requests_checkpoint` FOREIGN KEY (`shard_group`, `shard_id`, `entity_type`, `entity_id`) REFERENCES `cluster_machine_checkpoints` (`shard_group`, `shard_id`, `entity_type`, `entity_id`) ON UPDATE NO ACTION ON DELETE NO ACTION
);
