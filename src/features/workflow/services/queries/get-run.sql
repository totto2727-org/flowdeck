SELECT runs.run_id AS runId, workflow_id AS workflowId, workflow_version AS workflowVersion,
  graph_id AS graphId, status, runs.revision AS revision, snapshot_json AS snapshotJson,
  created_at AS createdAt, updated_at AS updatedAt
FROM runs JOIN run_states ON runs.run_id = run_states.run_id
WHERE runs.run_id = :runId
LIMIT 1;
