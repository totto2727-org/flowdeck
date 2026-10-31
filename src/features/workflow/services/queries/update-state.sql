UPDATE run_states SET revision = :revision, snapshot_json = :snapshotJson
WHERE run_id = :runId AND revision = :expectedRevision
  AND EXISTS (SELECT commit_id FROM commit_receipts WHERE commit_id = :commitId AND command_json = :commandJson);
