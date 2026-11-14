# Run History Retention

## Status

This document records the implemented in-memory retention and SSE design.

## Recorded data

One process-wide `WorkflowService` is shared by every connected client.
Each `RunSnapshot` represents one workflow run and contains the accepted input, trigger, lifecycle status, current and traversed graph state, timestamps, duration, and the retained `StepTrace` values for that run.

Running snapshots and terminal snapshots have different ownership:

- Running snapshots remain mutable while the workflow driver records node and run lifecycle changes.
- Completed, failed, and skipped snapshots are immutable history entries.

## In-memory limits

Two independent non-zero limits control memory and execution:

- `WorkflowConfig::max_concurrent_runs`: maximum concurrent workflow drivers. The local default is 100.
- `run_retention: RunRetention::KeepLatest(capacity)`: terminal snapshot retention. The local default is 100.

The effective maximum retained history is therefore 100 active runs plus 100 terminal runs with the local defaults.
A manual or scheduled run that would exceed `max_concurrent_runs` does not wait in a queue.

An `ActiveRunGroup` uses an RAII guard as the wait-group-style lifecycle boundary.
Joining the group is an immediate bounded operation; dropping the guard when the workflow driver exits is the corresponding completion signal.
The group uses a Tokio semaphore internally, but the permit is owned by the driver task rather than by history storage.

Running snapshots are stored in a `HashMap<RunId, RetainedRun>` so frequent lookup, mutation, and terminal removal are keyed by run ID.
Completion or failure removes the snapshot from the map and moves it into terminal history.
Skipped schedule attempts never join the active run group and are inserted directly into terminal history.

A manual Run action rejected at the limit returns `WorkflowError::ActiveRunLimit`; the existing request alert displays the error without navigating.
A cron firing rejected at the limit is automatically retained as a terminal `Failed` run and emitted through the normal `RunFailed` lifecycle event.

Terminal history uses [`ringbuffer::AllocRingBuffer`](https://docs.rs/ringbuffer/0.16.0/ringbuffer/struct.AllocRingBuffer.html).
`enqueue` overwrites the oldest terminal snapshot after the configured capacity is reached.
No graph-flow session deletion, removal event, or other synchronization runs when an old terminal snapshot is overwritten.

## Step trace retention

Step traces are owned by their `RunSnapshot` and are released when that terminal snapshot is overwritten.
There is no separate `KeepLatest` policy for `RunSnapshot.steps`.

Workflow execution limits provide the normal per-run trace-count bound:

- The default workflow step budget is the workflow node count multiplied by five.
- The default per-node execution limit is five.
- A workflow may provide an explicit execution-limit override.

These limits do not bound the byte size of an individual input, output, or error value.
A captured-payload byte limit remains a separate future option if measured workloads show excessive retained output data.

## Browser history rendering

The browser has no separate row limit, DOM eviction, hidden overflow rows, or pagination.
The initial server-rendered page and subsequent SSE patches render every retained run that matches the active workflow, trigger, and status filters.
The server-side active and terminal limits provide the normal row bound.

## SSE behavior

SSE is an invalidation signal for server-owned current state, not a replayable event log.

For each history SSE connection:

1. Subscribe to the process-wide workflow lifecycle broadcast before reading history.
2. Read the retained history, apply that connection's filters, and replace the complete `#run-history-body` content.
3. Re-read and replace the complete filtered body after `RunStarted`, `RunCompleted`, `RunFailed`, or `RunSkipped`.
4. Ignore `NodeStarted` and `NodeCompleted` because they do not change history-table membership or its displayed lifecycle status.
5. If the broadcast receiver lags, render the latest current history and continue the connection.

Subscribing before the first snapshot avoids missing a state change between the initial read and live listening.
A queued event may cause one redundant render, which is safe.
Reconnection always starts with a full current history patch.

The selected-run SSE follows the same current-state rule.
It renders the current inspector on connection and after matching workflow events, and re-renders the latest inspector after receiver lag instead of reloading the page.

The implementation does not include a replay journal, history revisions, `Last-Event-ID`, an `after` cursor, a dedicated history-delta channel, filter-membership merge state, or revision-gap handling.
The only retained broadcast queue is the workflow lifecycle channel, with a local default capacity of 128.

## Multiple-client ownership

The workflow service, run history, graph sessions, scheduler state, active run group, and workflow lifecycle sender are process-wide.
A run started by one client is visible to every other client whose current history filter includes it.
The active-run limit is also shared across clients rather than applied per browser.

Presentation state remains connection-local:

- The selected workflow and selected run are represented by the URL path.
- History filters are represented by canonical URL query parameters.
- The selected trace target, selected step, follow-latest mode, form input, and request message are Datastar signals initialized in each document.
- Each browser opens its own selected-run SSE connection and filtered history SSE connection.

Each history SSE connection parses its own filter query and renders its own filtered snapshot.
If one client falls behind the workflow broadcast queue, only that connection refreshes its current filtered state.

## Non-goals

- Persistent database history.
- Cross-process history or replay.
- Authentication, authorization, tenant isolation, or per-user saved filters.
- Browser-side history limits, DOM eviction, or pagination.
- Full-text search beyond the existing workflow, trigger, and status filters.
