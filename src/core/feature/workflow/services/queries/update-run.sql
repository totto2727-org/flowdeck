UPDATE runs SET status = :status, revision = :revision, updated_at = :updatedAt,
  last_sequence = last_sequence + :eventCount::integer
WHERE run_id = :runId AND revision = :expectedRevision
  AND EXISTS (SELECT commit_id FROM commit_receipts WHERE commit_id = :commitId AND command_json = :commandJson);
