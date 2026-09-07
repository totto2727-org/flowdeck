# QA Design: SQLite storage migration

- **Identifier:** sqlite-storage
- **Author:** Jcode
- **Source:** [Storage design](../../plans/sqlite-storage.md), PR #2, and the requested SQLite and validation boundaries
- **Created at:** 2026-09-05
- **Status:** draft

## Overview

- SC-1: Runs with snapshot-derived start/finish timestamps, traces, graph sessions, and leases are stored in one Turso database rather than parallel application caches.
- SC-2: Committed migrations initialize an empty database and reopening preserves terminal history without replaying interrupted work.
- SC-3: External DTOs and ORM rows are validated before domain construction, including multi-value consistency checks.
- SC-4: Manual execution, history navigation, trace selection, filtering, and live updates continue working in the browser.
- SC-5: Retention and concurrent session/lease operations preserve existing execution semantics.

## Rationale for automated vs. manual

Storage, serialization, concurrency, and recovery contracts use automated Rust assertions and integration scenarios against real SQLite.
The browser scenarios use the already configured Jcode built-in browser, as explicitly requested, to inspect real Topcoat and Datastar behavior rather than substitutes.
No real provider invocation is needed to verify the ordinary workflow or storage contracts.

## Test file placement policy

Storage tests live in `src/storage_test.rs`, and DTO tests live beside their implementations under `src/storage/`.
Driver failure-injection tests remain beside the driver under `src/workflow/driver/`.
Public workflow lifecycle tests remain under `tests/`.
The following numbered cases describe the AI-driven acceptance review and reference the independent automated evidence rather than duplicating its executable cases.

## Essential test cases

| ID | Target SC | Expected behavior | Actor | Style | Pass criterion | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| TC-001 | SC-1 | All durable application stores use SQLite | ai-driven | inspection | Review finds no in-memory session store, run map, terminal ring, or lease set in the application backend | Executable registries and live control resources are not stored data |
| TC-002 | SC-2 | Migration and recovery coverage is exercised | ai-driven | inspection | Review actual passing tests for fresh schema, reopening, exclusive file ownership, and interrupted-run recovery | Automated results are recorded below |
| TC-003 | SC-3 | Persisted and parsed values cross validated boundaries | ai-driven | inspection | Review separate ORM/Serde/domain types and passing corruption, scalar, and collection-invariant tests | Opaque state remains isolated |
| TC-004 | SC-4 | Manual workflow reaches a terminal trace | ai-driven | scenario | Submit a uniquely labeled ordinary workflow and observe completed history and step traces | Built-in browser only |
| TC-005 | SC-4 | Trace selection remains usable | ai-driven | scenario | Select an executed node/step and inspect output, timing, and state | Pointer and keyboard paths |
| TC-006 | SC-4 | History filters and navigation remain stable | ai-driven | scenario | Filter to a known status and reload the resulting URL without losing the filter | Live invalidation must preserve selection |
| TC-007 | SC-4 | Invalid input does not launch a run | ai-driven | scenario | Submit invalid workflow input and observe rejection without a new matching history entry | Browser-side and server-side checks are distinguished |
| TC-008 | SC-5 | Retention and concurrency behavior is verified | ai-driven | inspection | Review passing SQLite tests for start timestamp ordering with deterministic ID ties, active-run retention, session CAS, and lease exclusion | No mocked database |

## Implementation-driven test cases

| ID | Target SC | Expected behavior | Actor | Style | Pass criterion | Why required |
| --- | --- | --- | --- | --- | --- | --- |
| TC-IMPL-001 | SC-2 | SQLite dependency and package integration remains buildable | ai-driven | inspection | Pinned Nix environment completes the canonical local CI suite | Toasty and graph-flow previously selected incompatible native SQLite libraries |

## Coverage table

| SC ID | Corresponding TC-IDs |
| --- | --- |
| SC-1 | TC-001 |
| SC-2 | TC-002 |
| SC-3 | TC-003 |
| SC-4 | TC-004, TC-005, TC-006, TC-007 |
| SC-5 | TC-008 |

## Execution evidence

### Prior SQLite-driver evidence, 2026-09-05

`nix develop -c just ci` completed with exit code 0 on macOS aarch64 in the pinned Rust 1.95 environment.
Formatting, workspace/all-target/all-feature Clippy with `-D warnings`, Topcoat asset bundling, and the workspace build passed.
All **133 tests passed**: 70 library tests, 28 application tests, 17 public workflow integration tests, 10 jcode adapter tests, and 8 runtime-resource tests.
The optional real provider was not invoked.
The added SQLite checks confirm independent in-memory databases do not share runs, sessions, or leases, and committed SQL constraints reject invalid rows without poisoning subsequent valid writes.

| Review case | Result and concrete evidence |
| --- | --- |
| TC-001 | Passed source review: `ApplicationState` shares one `TursoStore`; sessions, run snapshots, and leases had database rows alongside the earlier draft counters with no parallel application caches. |
| TC-002 | Passed: `migrations_are_repeatable_and_match_the_schema`, `failed_migration_rolls_back_ddl_and_preserves_existing_rows`, `reopening_file_recovers_interrupted_runs_and_preserves_sessions`, the earlier draft counter-validation test (replaced by timestamp metadata validation), and schema-drift tests in `src/storage_test.rs`. |
| TC-003 | Passed: 14 run DTO tests, 10 session DTO tests, workflow input/configuration tests, and restored task-context tests reject malformed syntax, invalid scalar values, unsupported versions, duplicate/incorrect trace identities, inconsistent lifecycles, and invalid paths. |
| TC-008 | Passed: completion-order retention, rollback, orphan-prevention, and `concurrent_claims_and_session_saves_have_exactly_one_winner`; driver fault-injection tests confirm terminal events follow committed failure and are not fabricated when storage remains unavailable. |
| TC-IMPL-001 | Passed the canonical pinned-environment CI suite, for the earlier SQLite-driver revision. Current Turso-driver validation is recorded separately below. |
| TC-004 through TC-007 | **Blocked, not passed.** The required built-in browser could not perform page or tab operations. |

### Browser attempt

`nix develop -c just run` successfully bundled assets and started the server at `http://127.0.0.1:3000/`.
The built-in browser's `status` action reported that the bridge was installed and responding.
However, `open` with a new loopback tab and repeated `list_tabs` calls, including explicit Firefox selection, failed after about ten seconds with `failed printing to stderr: Broken pipe (os error 32)`.
No page inspection, interaction, SSE observation, or screenshot succeeded, and no alternative browser tool was substituted.
The discrepancy was reported through Jcode's maintainer feedback tool.
The QA server started for this attempt was stopped afterward.
Reconnect the Firefox bridge and execute [the browser procedure](./qa-flow.md#browser-procedure) before marking these cases complete.

### Supplemental HTTP verification

The SQLite server passed real HTTP checks for dashboard rendering, manual run submission, live SSE transitions from Running to Completed, completed-run reload with a status filter, and invalid-label rejection without history changes.
This does not exercise browser-side Datastar execution or pointer/keyboard interaction and does not replace the blocked browser cases.

### Tracker and follow-up

Linear synchronization is blocked by HTTP 401 from the configured credential, so no Linear update is claimed.
Provider session restart/resume is tracked separately in [issue #3](https://github.com/totto2727-org/flowdeck/issues/3).

### Current Turso-driver and remote configuration evidence

The canonical pinned-environment CI passed **170 tests** with the Turso sync driver and published graph-flow dependency.
Existing migration, memory isolation, file reopening, recovery, retention, CAS, and DTO/domain validation checks pass against Turso.
The configuration tests cover nonempty settings, unchanged pass-through to the driver, and redacted debug/error output.
URL and token formats are interpreted by Turso rather than independently restricted by application configuration.
`remote_configuration_reaches_http_and_auth_failure_is_redacted` uses the real Turso HTTP client against a rejecting loopback endpoint to verify URL/token injection and sanitized startup failure.
`replication_failure_does_not_orphan_local_runs_or_leases` injects a driver configuration failure to verify locally committed operations still succeed while explicit flush reports failure.
`local_only_service_flush_is_a_successful_noop` exercises the public service API without a remote.
The loopback HTTP endpoint and driver fault injection are boundary tests, not successful Turso Cloud synchronization evidence.
Real Cloud bootstrap/push/pull remains unverified because no dedicated remote URL and credential were supplied.
The real local application also passed dashboard, manual run, Running-to-Completed SSE, filtered reload, and invalid-label HTTP checks with this driver.
Browser interaction and Linear blockers remain as recorded above.

### Snapshot timestamp replacement evidence, 2026-09-07

`nix develop --command just ci` completed with exit code 0 on macOS aarch64 using the pinned Rust 1.95 environment.
Formatting, workspace/all-target/all-feature Clippy with `-D warnings`, Topcoat bundling, and the workspace/all-feature build passed.
All **147 tests passed**: 84 library tests, 28 application tests, 17 public workflow integration tests, 10 jcode adapter tests, and 8 runtime-resource tests.

| Contract | Passing executable evidence |
| --- | --- |
| Single rebuilt initial migration and repeatable initialization | `migrations_are_repeatable_and_match_the_schema` and schema-boundary rejection tests |
| History uses snapshot start milliseconds rather than insertion or completion order | `history_sorts_by_start_timestamp_despite_insertion_and_completion_order` |
| Equal start milliseconds use run ID as a deterministic tie-breaker | `equal_start_milliseconds_are_sorted_by_id_not_insertion_or_submillisecond_time` |
| Start and finish columns derive independently from snapshots while preserving original precision | `run_timestamp_columns_follow_snapshot_times_without_losing_snapshot_precision` and `terminal_insert_preserves_independent_start_and_finish_times` |
| Running updates accept Unix epoch zero and retain a null finish timestamp | `running_mutation_preserves_optional_finish_timestamp` |
| Recovery preserves retained timestamps and writes the recovered finish time consistently | `reopening_file_recovers_interrupted_runs_and_preserves_sessions` |
| Corrupt timestamp metadata is rejected before recovery mutates other rows | `startup_rejects_timestamp_metadata_disagreement_before_recovery` |

The full suite exposed an untyped SQL null-bind failure during running updates, which was fixed with an explicit 64-bit integer bind type and covered by the running-mutation regression test.
Tracked-source review found no remaining sequence columns, clock model/table, counter allocation, or counter verification implementation.
No user database was reset or deleted, and no compatibility migration was added for earlier unmerged drafts.
Browser and real Cloud synchronization were not rerun for this storage-only change, and no new evidence is claimed for those previously recorded boundaries.

### Typed run-status evidence, 2026-09-07

After replacing `RunRow.status: String` with the dedicated `RunStatusRow` Toasty embedded enum, `nix develop --command just ci` completed with exit code 0.
All **148 tests passed**, including the new `run_status_enum_round_trips_all_variants_through_the_database` test.
The test verifies Running, Completed, Failed, and Skipped through real ORM insertion and decoding, confirms their raw SQL labels, and reconstructs the corresponding domain statuses without losing failure or skip details.
Existing schema constraints, timestamp consistency, running updates, terminal transitions, and file recovery tests remain green.
The enum occupies the existing single text column, so the initial migration and SQL CHECK constraint are unchanged by this follow-up.
The unit-enum representation follows the [Toasty 0.10 Embed documentation](https://docs.rs/toasty/0.10.0/toasty/derive.Embed.html#enums), verified against the locally installed version-matched macro source.
