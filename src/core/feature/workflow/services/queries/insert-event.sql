WITH input AS (SELECT :eventId::text AS eventId, :commitId::text AS commitId)
INSERT INTO run_events (event_id, run_id, commit_id, sequence, node_id, execution_id, attempt, type, payload_json, created_at)
SELECT input.eventId, run_id, commit_id, first_sequence + :eventIndex::integer,
  :nodeId::nullable(text), :executionId::nullable(text), :attempt::nullable(integer), :type::text, :payloadJson::text, :createdAt::text
FROM commit_receipts CROSS JOIN input
WHERE commit_id = input.commitId AND run_id = :runId AND command_json = :commandJson
  -- Only identical receipt redelivery skips an event. Another receipt's event ID must fail UNIQUE.
  AND NOT EXISTS (SELECT event_id FROM run_events WHERE event_id = input.eventId AND commit_id = input.commitId);
