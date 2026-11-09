WITH input AS (
  SELECT :shardGroup::text AS shard_group, :shardId::integer AS shard_id,
    :entityType::text AS entity_type, :entityId::text AS entity_id,
    :machineId::text AS machine_id, :version::text AS version,
    :requestId::text AS request_id, :snapshotJson::text AS snapshot_json
)
INSERT INTO cluster_machine_checkpoints (
  shard_group, shard_id, entity_type, entity_id, machine_id, version, request_id, snapshot_json
)
SELECT shard_group, shard_id, entity_type, entity_id, machine_id, version, request_id, snapshot_json FROM input
WHERE NOT EXISTS (
  SELECT 1 FROM cluster_machine_requests r
  WHERE r.shard_group = input.shard_group AND r.shard_id = input.shard_id
    AND r.entity_type = input.entity_type AND r.entity_id = input.entity_id AND r.request_id = input.request_id
)
ON CONFLICT (shard_group, shard_id, entity_type, entity_id) DO UPDATE SET
  machine_id = excluded.machine_id, version = excluded.version,
  request_id = excluded.request_id, snapshot_json = excluded.snapshot_json;
