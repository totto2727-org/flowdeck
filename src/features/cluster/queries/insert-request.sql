INSERT INTO cluster_machine_requests (shard_group, shard_id, entity_type, entity_id, request_id)
VALUES (:shardGroup::text, :shardId::integer, :entityType::text, :entityId::text, :requestId::text)
ON CONFLICT (shard_group, shard_id, entity_type, entity_id, request_id) DO NOTHING;
