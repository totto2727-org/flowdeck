INSERT INTO graphs (graph_id, schema_version, graph_json) VALUES (:graphId, :schemaVersion, :graphJson)
ON CONFLICT (graph_id) DO NOTHING;
