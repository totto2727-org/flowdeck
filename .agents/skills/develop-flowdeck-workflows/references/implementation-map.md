# Workflow implementation map

## Source map

| Concern | Current source | Required action |
| --- | --- | --- |
| Workflow-owned definition | `src/workflows/<workflow>/definition.rs` | Define input, form, defaults, metadata, parser, and graph. |
| Multi-file module facade | `src/workflows/<workflow>.rs` | Re-export registry functions and own optional hooks, tasks, or adapters. |
| Central registry | `src/workflows.rs` | Add the module, definition, form/default/parser/graph match arms, and schedule behavior. |
| Run initialization | `src/workflow.rs` | Change only when the workflow needs a new shared runtime dependency or context key. |
| Driver and route recording | `src/workflow/driver.rs`, `src/workflow/driver/records.rs` | Usually unchanged; verify every runtime transition maps to one declared `EdgeSpec` and every execution receives a distinct `StepId`. |
| Execution limits | `src/workflow_limits.rs`, `WorkflowDefinition::limits` | Prefer strict derived defaults; add a workflow override only for an explicit operational need. |
| Typed trace state | `src/workflow_trace.rs` | Add only operator-relevant workflow state and keep sensitive values redacted. |
| Topology layout | `src/features/run_detail/component/topology/geometry.rs` | Generic layered layout derives positions, paths, self-edge loops, and viewBox; never add workflow-ID coordinate matches. |
| Topology and trace rendering | `src/features/run_detail/component/topology/renderer.rs`, `src/features/run_detail/component/step_trace.rs` | Usually data-driven; change only for a new presentation contract. |
| Workflow rail and action | `src/features/workflow_launcher/` | Usually unchanged because both consume the central registry. |
| History filters and routes | `src/features/run_history/`, `src/app/routes.rs` | Usually unchanged because workflow IDs are validated through `workflow_definitions()`. |
| Schedules | `src/workflow_scheduler.rs`, `src/workflows.rs` | Declare every schedule and its overlap policy; the scheduler validates and runs all of them concurrently. |
| Domain errors | `src/lib.rs::WorkflowError` | Add a variant only for a new boundary failure class and update `Display`. |
| Integration coverage | `tests/workflow_history.rs`, `tests/workflow_events.rs`, component tests | Protect registration, input rejection, route completion, events, topology, and traces. |

## Definition checklist

Create the following workflow-owned elements:

- `WORKFLOW_ID`: URL-safe and stable.
- Input DTO: private, `Debug`, `Deserialize`, `Validate`, and `deny_unknown_fields`.
- `NODES`: one entry per real graph task with a concise UI label.
- `EDGES`: one entry per possible real transition with unique IDs.
- `DEFINITION`: use the same ID, start task, node slice, and edge slice as the graph.
- `input_form(active)`: preserve the shared Topcoat/Datastar form contract.
- `default_input()`: return a complete JSON object matching all form bindings.
- `parse_input(Value)`: deserialize, validate, normalize, summarize, and return `RunInput`.
- `build_graph(...)`: build with `GraphBuilder::new(WORKFLOW_ID)` and translate `GraphError` through `graph_build_error`.

Use `pub(super)` for a definition reached through the parent registry. Use `pub(crate)` only when the multi-file facade or another crate-level module must reach the item.

## Registry checklist

Update all of these together in `src/workflows.rs`:

1. Declare the module.
2. Increment the `DEFINITIONS` array length and append `DEFINITION`.
3. Render `input_form` from `workflow_input_form`.
4. Return `default_input` from `workflow_default_input`.
5. Build the graph from `build_graph` and pass only the runtime dependencies it needs.
6. Parse input from `parse_input`.
7. Add the workflow to `scheduled_input`: dispatch its schedule or return `UnknownSchedule`.

Do not add workflow-specific branches to the rail, route parser, history filter, inspector, or trace list unless the generic registry-driven behavior is insufficient.

## Graph and driver invariants

The driver records an edge by finding `EdgeSpec.from == current_task_id` and `EdgeSpec.to == next_task_id`. If metadata and `GraphBuilder` differ, execution can succeed while the UI omits the selected edge and traversed route.

Check these invariants explicitly:

- Node IDs are unique inside the workflow.
- Edge IDs are unique inside the workflow.
- Every `EdgeSpec.from` and `EdgeSpec.to` exists in `NODES`.
- `DEFINITION.start_node` exists and equals the session's first graph task.
- Every non-terminal task can reach a terminal task.
- Every possible runtime transition is represented once in `EDGES`.
- Conditional paths declare both UI edges.
- Self-reference is a normal conditional edge; exclude it from rank calculation and render it as an external loop.
- Terminal tasks return `NextAction::End`; intermediate tasks return the intended continuation action.

`GraphBuilder` validates graph structure, but it does not validate `NodeSpec`, `EdgeSpec`, or the presentation layout. Add tests for these application-owned representations and confirm every registered workflow receives nonzero computed geometry.

Every node execution appends a `StepTrace` with a one-based run-local `StepId` and `node_execution` ordinal. Never finish or fail a step by searching only its node ID. Repeated node IDs remain in `traversed_nodes`; the chronological execution list is the renderer-independent navigation source.

## Input and state boundaries

The service stores normalized input under `WORKFLOW_INPUT_KEY` and its display summary under `INPUT_SUMMARY_KEY`. Tasks must read typed values from those keys rather than reparsing form bodies or reaching into HTTP state.

Keep validation at `parse_input`:

- Reject unknown fields with Serde.
- Use Garde for length, range, and custom validation.
- Validate before trimming when limits must include surrounding user input.
- Trim or canonicalize accepted values before storing them.
- Keep `RunInput::summary` short and free of credentials or large content.

Lexical validation does not prevent a symlink inside the workspace from resolving outside it. For existing read targets, canonicalize the workspace and resolved target, then require the target to remain under the workspace root. For a new write target, validate and resolve the nearest existing parent without requiring the target itself to exist. State the symlink policy explicitly instead of assuming that rejecting `..` provides containment.

`StepState::after` currently retains normalized input, shared synthetic task state, and a redacted `JcodeOutput`. When a new workflow needs additional observable state, extend `StepState` with a typed optional field and read it from `Context`. Do not serialize the entire context or provider credentials.

## Task selection

Use the smallest task boundary that matches the workflow:

- Reuse `task(...)`, `TaskBehavior`, and `TaskDelay` for the existing synthetic continue/choose/end behavior.
- Implement a workflow-owned `Task` for domain work, external I/O, or routing that is not shared.
- Extend a shared enum only when at least two workflows need the new semantic and update every exhaustive match in the same change.
- Use `JcodeNode` for coding-agent work and configure prompt/session/run hooks at their native boundaries.

Do not run blocking filesystem or process APIs directly on the async graph executor. Prefer Tokio async APIs; use `tokio::task::spawn_blocking` when the library is synchronous, and translate join and operation failures into actionable `GraphError` values.

For a multi-node jcode coding sequence, capture `JCODE_SESSION_KEY` from `Context` and select `SessionMode::Reuse`. A static validation node between agent nodes does not clear the key, so the later jcode node resumes the same session. Use `SessionMode::New` or a distinct key when histories must be isolated.

## Schedule and limit boundaries

`workflow_schedules()` exposes every validated schedule and `run_scheduler()` owns one `JoinSet` worker per schedule. Therefore:

- A workflow without a schedule still needs an explicit `UnknownSchedule` registry branch.
- Schedule IDs must be globally unique and every scheduled input must parse during service startup.
- `ScheduleSpec::new` skips overlap by default and retains the skipped attempt in run history.
- `AllowOverlap` is an explicit code-defined override; never select it from workflow behavior heuristics.
- Dropping the scheduler future drops its `JoinSet` and all schedule workers with the server.
- Test direct `trigger_schedule`, input selection, skipped history, and configured overlap.

`WorkflowDefinition::execution_limits()` resolves either an explicit override or strict defaults. Keep workflow total timeout/step count and node timeout/execution count enforced in the console driver because graph-flow's chained-step limit does not cover this application's repeated one-step loop.

## Minimum test matrix

Add tests proportional to the workflow:

| Boundary | Assertion |
| --- | --- |
| Registry | `workflow_definitions()` contains the ID, metadata, nodes, and edges. |
| Defaults | `workflow_default_input()` contains every form-bound field. |
| Valid input | Normalized state and summary enter the initial context. |
| Invalid input | Unknown, blank, oversized, out-of-range, or unsafe fields return `InvalidInput` and create no run. |
| Graph build | The service builds every registered graph. |
| Execution | A representative path reaches `Completed` with the expected first/last nodes and route. |
| Branching | Each conditional route is reachable or its predicate is deterministically tested. |
| Topology | Every node receives computed geometry, viewBox contains it, and self-edges use an external curve. |
| Trace | Exact `StepId`, per-node execution ordinal, selected edge, node output, typed state, and failure messages are retained. |
| Limits | Derived defaults match node count; a sixth node execution and total-step overflow are rejected before execution. |
| Schedule overlap | Default overlap retains `Skipped`; explicit `AllowOverlap` starts both runs. |
| Events | Start, node, edge, completion, and failure events remain ordered when behavior changes. |
| Jcode | Same key reuses a session; new or different keys isolate sessions; real credentials stay out of unit tests. |

Use `WorkflowService::without_jcode_runtime()` for catalog, rendering, and non-jcode execution tests. Use `WorkflowService::new()` only when the test is intentionally exercising the installed jcode binary and configured provider.

## Common failure patterns

- The workflow appears in the rail but has no form: the `workflow_input_form` arm is missing.
- The form appears empty after navigation: `default_input` is missing a bound field or the default registry arm is missing.
- Submission returns unknown workflow: `DEFINITIONS`, `definition`, graph, or parser registration is incomplete.
- A run starts but immediately fails: the start node, task ID, input context key, or terminal action differs from the definition.
- The route omits an edge: the real `current -> next` transition has no matching `EdgeSpec`.
- Nodes overlap or an edge clips: the generic layout algorithm mishandles that graph shape; fix the layout engine rather than matching workflow IDs.
- Trace state is empty: `StepState::after` cannot read `WORKFLOW_INPUT_KEY` or the new state was never added to its typed projection.
- A cron never starts: startup validation rejected a duplicate ID, invalid expression, unknown workflow, or invalid scheduled input.
- A skipped cron is invisible: the trigger path logged instead of retaining `RunStatus::Skipped` and emitting `RunSkipped`.
- A repeated node shows only its latest run: selection is still keyed by node ID instead of exact `StepId`.
- A validated relative path still escapes the workspace: a symlink was followed without a canonical containment check.
- Other runs stall while one node works: a blocking filesystem, process, or SDK call ran directly on the async executor.
- Tests spawn jcode unexpectedly: use the runtime-free service constructor except in focused integration coverage.
