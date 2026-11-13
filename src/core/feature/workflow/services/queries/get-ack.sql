SELECT commit_id AS commitId, run_id AS runId, revision, first_sequence AS firstSequence, event_count AS eventCount
FROM commit_receipts WHERE commit_id = :commitId AND run_id = :runId AND command_json = :commandJson
LIMIT 1;
