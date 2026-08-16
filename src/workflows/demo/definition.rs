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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DemoInput {
    label: String,
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
    view! {
        <form class="run-form" data-workflow-run-form="" data-workflow-id=(WORKFLOW_ID) data-active=(active.to_string()) aria-labelledby="demo-run-form-title">
            <div><p class="eyebrow">"Run selected"</p><h3 id="demo-run-form-title">"Branch and converge"</h3></div>
            <label class="field" for="demo-run-label"><span>"Run label"</span><input id="demo-run-label" name="label" type="text" value="manual branch run" required="required" maxlength="80"></label>
            <label class="field" for="demo-step-delay"><span>"Step delay (ms)"</span><input id="demo-step-delay" name="step_delay_ms" data-json-type="number" type="number" value="350" min="100" max="2000" step="10" required="required"></label>
            <button type="submit" data-run-workflow="">"Run workflow"</button>
        </form>
    }
}

pub(super) fn parse_input(value: Value) -> Result<RunInput, WorkflowError> {
    let input = serde_json::from_value::<DemoInput>(value).map_err(|error| {
        WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: {error}"),
        }
    })?;
    let label = input.label.trim().to_owned();
    if label.is_empty() || label.chars().count() > 80 {
        return Err(WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: label must contain between 1 and 80 characters"),
        });
    }
    if !(100..=2_000).contains(&input.step_delay_ms) {
        return Err(WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: step_delay_ms must be between 100 and 2000"),
        });
    }
    let summary = format!("{label} · {} ms", input.step_delay_ms);
    Ok(RunInput::new(
        json!({ "label": label, "step_delay_ms": input.step_delay_ms }),
        summary,
    ))
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
