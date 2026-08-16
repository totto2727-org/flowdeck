use garde::Validate;
use graph_flow::GraphBuilder;
use serde::Deserialize;
use serde_json::{Value, json};
use topcoat::{
    Result,
    view::{component, view},
};

use super::{
    EdgeSpec, NodeSpec, WorkflowDefinition, graph_build_error,
    task::{TaskBehavior, TaskDelay, task},
};
use crate::{RunInput, ScheduleSpec, WorkflowError};

pub(super) const WORKFLOW_ID: &str = "demo-workflow";
const BRANCH_KEY: &str = "branch_yes";

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct DemoInput {
    #[garde(custom(validate_non_blank), length(chars, max = 80))]
    label: String,
    #[garde(range(min = 100, max = 2_000))]
    step_delay_ms: u64,
}

const NODES: [NodeSpec; 6] = [
    NodeSpec {
        id: "prepare",
        label: "Prepare",
    },
    NodeSpec {
        id: "choose_route",
        label: "Choose route",
    },
    NodeSpec {
        id: "yes_path",
        label: "Yes path",
    },
    NodeSpec {
        id: "fallback_path",
        label: "Fallback path",
    },
    NodeSpec {
        id: "converge",
        label: "Converge",
    },
    NodeSpec {
        id: "complete",
        label: "Complete",
    },
];

const EDGES: [EdgeSpec; 6] = [
    EdgeSpec {
        id: "prepare-to-choose",
        from: "prepare",
        to: "choose_route",
    },
    EdgeSpec {
        id: "choose-to-yes",
        from: "choose_route",
        to: "yes_path",
    },
    EdgeSpec {
        id: "choose-to-fallback",
        from: "choose_route",
        to: "fallback_path",
    },
    EdgeSpec {
        id: "yes-to-converge",
        from: "yes_path",
        to: "converge",
    },
    EdgeSpec {
        id: "fallback-to-converge",
        from: "fallback_path",
        to: "converge",
    },
    EdgeSpec {
        id: "converge-to-complete",
        from: "converge",
        to: "complete",
    },
];

pub(super) const DEFINITION: WorkflowDefinition = WorkflowDefinition {
    workflow_id: WORKFLOW_ID,
    name: "Branch and converge",
    description: "Six fixed tasks with one conditional route.",
    start_node: "prepare",
    nodes: &NODES,
    edges: &EDGES,
};

pub(super) const SCHEDULES: [ScheduleSpec; 1] = [ScheduleSpec {
    schedule_id: "demo-every-10-seconds",
    workflow_id: WORKFLOW_ID,
    cron_expression: "*/10 * * * * *",
    input_summary: "scheduled heartbeat · 250 ms",
}];

#[component]
pub(super) async fn input_form(active: bool) -> Result {
    let _ = active;
    view! {
        <form
            class="mt-4 grid gap-3 border-t border-border pt-4"
            data-show=(format!("$selectedWorkflowId === '{WORKFLOW_ID}'"))
            data-workflow-id=(WORKFLOW_ID)
            data-on:submit="@post('/actions/runs')"
            data-indicator="_requesting"
            aria-labelledby="demo-run-form-title"
        >
            <div>
                <p
                    class="text-xs font-semibold uppercase tracking-label text-text-muted"
                >
                    "Run selected"
                </p>
                <h3 class="text-xl font-semibold" id="demo-run-form-title">
                    "Branch and converge"
                </h3>
            </div>
            <label
                class="grid gap-1 text-sm font-semibold text-text-secondary"
                for="demo-run-label"
            >
                <span>"Run label"</span>
                <input
                    class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                    id="demo-run-label"
                    name="label"
                    type="text"
                    data-bind="input.label"
                    required="required"
                    maxlength="80"
                >
            </label>
            <label
                class="grid gap-1 text-sm font-semibold text-text-secondary"
                for="demo-step-delay"
            >
                <span>"Step delay (ms)"</span>
                <input
                    class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                    id="demo-step-delay"
                    name="step_delay_ms"
                    type="number"
                    data-bind="input.step_delay_ms"
                    min="100"
                    max="2000"
                    step="10"
                    required="required"
                >
            </label>
            <button
                class="min-h-[var(--control-min)] rounded-control border border-accent-hover bg-accent px-4 font-semibold text-text-primary shadow-inset transition-[filter,transform] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 active:translate-y-[var(--border-width)] disabled:cursor-wait disabled:opacity-65"
                type="submit"
                data-attr:disabled="$_requesting"
            >
                "Run workflow"
            </button>
        </form>
    }
}

pub(super) fn default_input() -> Value {
    json!({ "label": "manual branch run", "step_delay_ms": 350 })
}

pub(super) fn parse_input(value: Value) -> Result<RunInput, WorkflowError> {
    let input = serde_json::from_value::<DemoInput>(value).map_err(|error| {
        WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: {error}"),
        }
    })?;
    input
        .validate()
        .map_err(|error| WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: {error}"),
        })?;
    let label = input.label.trim().to_owned();
    let summary = format!("{label} · {} ms", input.step_delay_ms);
    Ok(RunInput::new(
        json!({ "label": label, "step_delay_ms": input.step_delay_ms }),
        summary,
    ))
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    reason = "Garde custom validators receive their context by reference."
)]
fn validate_non_blank(value: &str, _: &()) -> garde::Result {
    if value.trim().is_empty() {
        return Err(garde::Error::new("must not be blank"));
    }
    Ok(())
}

pub(super) fn scheduled_input(schedule_id: &str) -> Result<Value, WorkflowError> {
    if schedule_id == SCHEDULES[0].schedule_id {
        return Ok(json!({ "label": "scheduled heartbeat", "step_delay_ms": 250 }));
    }
    Err(WorkflowError::UnknownSchedule {
        schedule_id: schedule_id.to_owned(),
    })
}

pub(super) fn build_graph() -> Result<graph_flow::Graph, WorkflowError> {
    GraphBuilder::new(WORKFLOW_ID)
        .add_task(task(
            "prepare",
            TaskBehavior::Continue,
            TaskDelay::InputMilliseconds("step_delay_ms"),
        ))
        .add_task(task(
            "choose_route",
            TaskBehavior::Choose,
            TaskDelay::InputMilliseconds("step_delay_ms"),
        ))
        .add_task(task(
            "yes_path",
            TaskBehavior::Continue,
            TaskDelay::InputMilliseconds("step_delay_ms"),
        ))
        .add_task(task(
            "fallback_path",
            TaskBehavior::Continue,
            TaskDelay::InputMilliseconds("step_delay_ms"),
        ))
        .add_task(task(
            "converge",
            TaskBehavior::Continue,
            TaskDelay::InputMilliseconds("step_delay_ms"),
        ))
        .add_task(task(
            "complete",
            TaskBehavior::End,
            TaskDelay::InputMilliseconds("step_delay_ms"),
        ))
        .add_edge("prepare", "choose_route")
        .add_conditional_edge(
            "choose_route",
            |context| {
                context
                    .get::<bool>(BRANCH_KEY)
                    .is_some_and(|selected| selected)
            },
            "yes_path",
            "fallback_path",
        )
        .add_edge("yes_path", "converge")
        .add_edge("fallback_path", "converge")
        .add_edge("converge", "complete")
        .build()
        .map_err(|error| graph_build_error(&error))
}
