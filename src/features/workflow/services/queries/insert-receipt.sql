INSERT INTO commit_receipts (commit_id, run_id, expected_revision, revision, first_sequence, event_count, command_json)
SELECT :commitId::text, run_id, :expectedRevision::integer, :revision::integer,
  last_sequence + 1, :eventCount::integer, :commandJson::text
FROM runs WHERE run_id = :runId
ON CONFLICT (commit_id) DO NOTHING;
