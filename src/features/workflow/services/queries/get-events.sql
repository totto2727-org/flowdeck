WITH input AS (SELECT :maxRevision::nullable(integer) AS maxRevision)
SELECT run_events.* FROM run_events
JOIN commit_receipts ON run_events.commit_id = commit_receipts.commit_id
CROSS JOIN input
WHERE run_events.run_id = :runId
  AND (input.maxRevision IS NULL OR commit_receipts.revision <= input.maxRevision)
ORDER BY sequence;
