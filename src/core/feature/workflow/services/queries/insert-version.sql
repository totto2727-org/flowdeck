INSERT INTO workflow_versions (workflow_id, version, graph_id) VALUES (:workflowId, :version, :graphId)
ON CONFLICT (workflow_id, version) DO NOTHING;
