---
name: develop-flowdeck-workflows
description: >-
  Develop and debug code-defined Flowdeck workflows across validated Topcoat
  forms, graph-flow definitions, registry integration, execution limits, trace
  state, schedules, tests, and browser verification. Use when creating or
  changing a workflow, adding nodes or edges, changing workflow-owned input or
  runtime dependencies, adding a schedule, or fixing a registered workflow that
  does not render, route, trace, or complete correctly. Do not use for generic
  Flowdeck UI, history, packaging, or server changes that do not alter a
  workflow contract.
license: MIT
metadata:
  author: totto2727
  version: "1.0.0"
---

# Develop Flowdeck Workflows

Implement a workflow as one vertical slice from its form boundary through graph execution and observable trace. Reuse the existing registry and rendering path instead of adding a parallel workflow framework.

Use this skill only when a code-defined workflow contract changes. Follow the repository `AGENTS.md` without this skill for generic dashboard, run-history, packaging, or server work.

## Required reading

Read [references/implementation-map.md](references/implementation-map.md) completely before editing. Re-read the relevant existing definition chosen as the nearest example:

- Use `src/workflows/review/definition.rs` for a small linear workflow.
- Use `src/workflows/demo/definition.rs` for branching, shared synthetic tasks, or a schedule.
- Use `src/workflows/jcode_translation/` for jcode nodes, runtime dependencies, hooks, filesystem validation, or a multi-file workflow module.

Inspect the current files rather than copying remembered line counts, array sizes, or match arms.

## Implementation workflow

1. Define the workflow contract before editing:
   - Choose a stable `WORKFLOW_ID`, module name, node IDs, edge IDs, start node, terminal nodes, input fields, and optional schedules.
   - Decide whether each node is a generic `WorkflowTask`, a workflow-owned `Task`, or a `JcodeNode`.
   - Decide whether output needs workflow-specific trace state.
   - Decide whether the strict application execution limits need a workflow override.
2. Add the workflow-owned module:
   - Keep a single-file workflow in `src/workflows/<name>/definition.rs` and register it with `#[path = ...]`.
   - Add `src/workflows/<name>.rs` only when the workflow needs supporting modules such as hooks, provider adapters, or task implementations.
3. Implement one definition slice containing:
   - `WORKFLOW_ID`.
   - A private `Deserialize + Validate` input type with `#[serde(deny_unknown_fields)]`.
   - `NODES`, `EDGES`, and `DEFINITION`.
   - `input_form`, `default_input`, `parse_input`, and `build_graph`.
   - Optional validators, schedules, prompts, hooks, or workflow-owned tasks.
4. Register every exhaustive boundary in `src/workflows.rs`:
   - Module declaration.
   - `DEFINITIONS` length and element.
   - `workflow_input_form`.
   - `workflow_default_input`.
   - `build_graph`.
   - `parse_input`.
   - `scheduled_input`, including an explicit `UnknownSchedule` branch when the workflow has no schedule.
5. Complete observable integration:
   - Confirm the automatic topology layout positions every node and routes self-edges outside the node.
   - Extend typed trace state only when the workflow produces state that operators must inspect.
   - Add a `WorkflowError` variant and its `Display` arm only for a genuinely new failure category.
   - Add shared enum variants only when the shared abstraction changes; prefer a workflow-owned task over widening `TaskBehavior` for one workflow.
6. Add boundary and execution tests before manual QA.
7. Run the workflow through the real console surface and inspect its topology, route, status, trace, and output.

## Input and form contract

Keep browser and server constraints aligned. Bind every control through `data-bind="input.<field>"`, provide a matching value in `default_input`, and deserialize the same field in the input type. Use unique label/control IDs, `data-workflow-id`, the shared `/actions/runs` submit action, and the existing request indicator.

Validate untrusted input before creating `RunInput`. Normalize accepted strings after validation, store only the normalized JSON state, and create a concise non-secret summary. Reject absolute paths, parent traversal, blank values, oversized values, and unknown fields at this boundary rather than inside a task.

Treat lexical relative-path validation and filesystem containment as separate checks. When a task reads an existing path, resolve it against the intended workspace and reject canonical paths that escape through symlinks. Use async filesystem APIs or `spawn_blocking` for blocking filesystem work inside a graph task.

## Graph and topology contract

Treat `WorkflowDefinition` and `GraphBuilder` as two representations of one graph:

- Make every task ID equal one `NodeSpec.id`.
- Make `start_node` equal the actual first task.
- Make every runtime transition have one matching `EdgeSpec { from, to }`.
- Give node and edge IDs globally understandable, stable names.
- Return `NextAction::End` from every terminal path.
- Add both possible `EdgeSpec` values for a conditional edge.
- Represent repetition with conditional self-edges or back-edges; do not add a special loop node type.

Do not add workflow IDs to topology geometry. `LayeredAutoLayout` derives ranks and coordinates from `NodeSpec` and `EdgeSpec`, excludes self-edges from rank calculation, routes self-edges outside their node, and derives the SVG viewBox from the result. Change the layout engine only when the generic graph shape is unsupported, and preserve the `TopologyLayoutEngine` and `TopologyRenderer` replacement boundaries.

## Execution limits

Leave `WorkflowDefinition::limits` as `None` to use strict application defaults: total steps are node count multiplied by `DEFAULT_WORKFLOW_STEP_MULTIPLIER`, total timeout is that step budget multiplied by `DEFAULT_WORKFLOW_TIMEOUT_PER_STEP`, and each node may execute `DEFAULT_NODE_MAX_EXECUTIONS` times with `DEFAULT_NODE_TIMEOUT` per execution.

Set `limits: Some(WorkflowExecutionLimits::new(...))` only when the workflow has a documented operational reason to override the defaults. Keep total and node limits independent even when their current numeric factors match. The driver records limit and timeout failures in the run and marks the exact running `StepId` failed when one exists.

## Jcode workflows

Reuse the application-owned `Arc<JcodeRuntime>`. Never launch a jcode process from a node.

- Use `SessionMode::Reuse` with the run-owned `JCODE_SESSION_KEY` when several nodes form one coding task and must share analysis and workspace history.
- Keep the default `SessionMode::New`, or use another key, for independent agents.
- Keep process-wide credentials and launch environment at runtime initialization.
- Keep session model, reasoning, working directory, prompt, run options, and turn hooks at their existing SDK boundaries.
- Use `WorkflowService::without_jcode_runtime()` in catalog and non-agent tests. Exercise the real runtime only in a focused integration or manual scenario.

## Schedules

Declare schedules with `ScheduleSpec::new`, which defaults to `ScheduleOverlapPolicy::SkipWhileRunning`. Use `.with_overlap_policy(ScheduleOverlapPolicy::AllowOverlap)` only when every firing must start. Do not infer overlap behavior from whether a workflow edits files.

The scheduler validates every schedule and scheduled input at startup, rejects duplicate IDs, and owns one structured worker per cron expression. A skipped firing is a `RunStatus::Skipped` history row with a `RunSkipped` event, not a silent log. Test each schedule ID through `trigger_schedule`, including overlap behavior when relevant.

## Verification

Run the complete repository gate from the repository root:

```bash
just ci
git diff --check
```

Manually verify the real console when the workflow or topology changes:

1. Open the workflow from the rail and confirm only its form is visible.
2. Confirm defaults populate every bound field.
3. Submit valid input and observe `Running` to `Completed`, or an actionable `Failed` state.
4. Confirm automatic node and edge positions, self-edge routing when present, traversed route, execution-count badges, chronological execution history, selected `StepId`, step timings, state, and output.
5. Submit invalid input and confirm it creates no run.
6. Confirm no credentials, temporary configuration, or generated output escaped its intended boundary.

Do not report completion from registry tests alone. A workflow is complete only when its actual execution and browser-visible trace agree with the declared graph.

## Handoff

Report the workflow ID, changed contract boundaries, automated validation, and the observed browser result. Name any provider credentials, binaries, or external services that prevented a real workflow execution instead of presenting static inspection as completed QA.
