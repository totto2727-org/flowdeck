INSERT INTO workflows (workflow_id, name) VALUES (:workflowId, :name)
ON CONFLICT (workflow_id) DO NOTHING;
