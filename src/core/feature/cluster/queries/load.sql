WITH input AS (
  SELECT :shardGroup::text AS shard_group, :shardId::integer AS shard_id,
    :entityType::text AS entity_type, :entityId::text AS entity_id, :requestId::text AS request_id
)
SELECT c.machine_id AS machineId, c.version, c.request_id AS requestId, c.snapshot_json AS snapshotJson,
  EXISTS (
    SELECT 1 FROM cluster_machine_requests r
    WHERE r.shard_group = input.shard_group AND r.shard_id = input.shard_id
      AND r.entity_type = input.entity_type AND r.entity_id = input.entity_id AND r.request_id = input.request_id
  ) AS processed
FROM cluster_machine_checkpoints c JOIN input
  ON c.shard_group = input.shard_group AND c.shard_id = input.shard_id
    AND c.entity_type = input.entity_type AND c.entity_id = input.entity_id;
