# QA Design: SQLite storage migration

- **Identifier:** sqlite-storage
- **Author:** Jcode
- **Source:** [Storage design](../../plans/sqlite-storage.md), PR #2, and the requested SQLite and validation boundaries
- **Created at:** 2026-09-05
- **Status:** draft

## Overview

- SC-1: Runs, traces, graph sessions, leases, and ordering counters are stored in one SQLite database rather than parallel application caches.
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
| TC-008 | SC-5 | Retention and concurrency behavior is verified | ai-driven | inspection | Review passing SQLite tests for start/completion ordering, active-run retention, session CAS, and lease exclusion | No mocked database |

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

### Automated evidence, 2026-09-05

`nix develop -c just ci` completed with exit code 0 on macOS aarch64 in the pinned Rust 1.95 environment.
Formatting, workspace/all-target/all-feature Clippy with `-D warnings`, Topcoat asset bundling, and the workspace build passed.
All **133 tests passed**: 70 library tests, 28 application tests, 17 public workflow integration tests, 10 jcode adapter tests, and 8 runtime-resource tests.
The optional real provider was not invoked.
The added SQLite checks confirm independent in-memory databases do not share runs, sessions, or leases, and committed SQL constraints reject invalid rows without poisoning subsequent valid writes.

| Review case | Result and concrete evidence |
| --- | --- |
| TC-001 | Passed source review: `ApplicationState` shares one `SqliteStore`; sessions, run snapshots, leases, and clocks have database rows with no parallel application caches. |
| TC-002 | Passed: `migrations_are_repeatable_and_match_the_schema`, `failed_migration_rolls_back_ddl_and_preserves_existing_rows`, `reopening_file_recovers_interrupted_runs_and_preserves_sessions`, `startup_rejects_missing_or_rewound_ordering_clocks`, and schema-drift tests in `src/storage_test.rs`. |
| TC-003 | Passed: 14 run DTO tests, 10 session DTO tests, workflow input/configuration tests, and restored task-context tests reject malformed syntax, invalid scalar values, unsupported versions, duplicate/incorrect trace identities, inconsistent lifecycles, and invalid paths. |
| TC-008 | Passed: completion-order retention, rollback, orphan-prevention, and `concurrent_claims_and_session_saves_have_exactly_one_winner`; driver fault-injection tests confirm terminal events follow committed failure and are not fabricated when storage remains unavailable. |
| TC-IMPL-001 | Passed the canonical pinned-environment CI suite, using the shared graph-flow dependency with PostgreSQL disabled; metadata confirms one graph-flow package, Toasty SQLite, and no SQLx or Turso packages. |
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
