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
use crate::{RunInput, WorkflowError};

pub(super) const WORKFLOW_ID: &str = "review-pipeline";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewInput {
    subject: String,
    reviewer: String,
}

const NODES: [NodeSpec; 4] = [
    NodeSpec {
        id: "receive",
        label: "Receive",
    },
    NodeSpec {
        id: "inspect",
        label: "Inspect",
    },
    NodeSpec {
        id: "approve",
        label: "Approve",
    },
    NodeSpec {
        id: "archive",
        label: "Archive",
    },
];

const EDGES: [EdgeSpec; 3] = [
    EdgeSpec {
        id: "receive-to-inspect",
        from: "receive",
        to: "inspect",
    },
    EdgeSpec {
        id: "inspect-to-approve",
        from: "inspect",
        to: "approve",
    },
    EdgeSpec {
        id: "approve-to-archive",
        from: "approve",
        to: "archive",
    },
];

pub(super) const DEFINITION: WorkflowDefinition = WorkflowDefinition {
    workflow_id: WORKFLOW_ID,
    name: "Review pipeline",
    description: "Four linear tasks for an inspect-and-approve pass.",
    start_node: "receive",
    nodes: &NODES,
    edges: &EDGES,
};

#[component]
pub(super) async fn input_form(active: bool) -> Result {
    view! {
        <form class="run-form" data-workflow-run-form="" data-workflow-id=(WORKFLOW_ID) data-active=(active.to_string()) aria-labelledby="review-run-form-title">
            <div><p class="eyebrow">"Run selected"</p><h3 id="review-run-form-title">"Review pipeline"</h3></div>
            <label class="field" for="review-subject"><span>"Review subject"</span><input id="review-subject" name="subject" type="text" value="release candidate" required="required" maxlength="80"></label>
            <label class="field" for="review-reviewer"><span>"Reviewer"</span><input id="review-reviewer" name="reviewer" type="text" value="local operator" required="required" maxlength="80"></label>
            <button type="submit" data-run-workflow="">"Run workflow"</button>
        </form>
    }
}

pub(super) fn parse_input(value: Value) -> Result<RunInput, WorkflowError> {
    let input = serde_json::from_value::<ReviewInput>(value).map_err(|error| {
        WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: {error}"),
        }
    })?;
    let subject = parse_text("subject", &input.subject)?;
    let reviewer = parse_text("reviewer", &input.reviewer)?;
    let summary = format!("{subject} · reviewer {reviewer}");
    Ok(RunInput::new(
        json!({ "subject": subject, "reviewer": reviewer }),
        summary,
    ))
}

fn parse_text(field: &str, value: &str) -> Result<String, WorkflowError> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.chars().count() > 80 {
        return Err(WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: {field} must contain between 1 and 80 characters"),
        });
    }
    Ok(value)
}

pub(super) fn build_graph() -> Result<graph_flow::Graph, WorkflowError> {
    GraphBuilder::new(WORKFLOW_ID)
        .add_task(task(
            "receive",
            TaskBehavior::Continue,
            TaskDelay::FixedMilliseconds(250),
        ))
        .add_task(task(
            "inspect",
            TaskBehavior::Continue,
            TaskDelay::FixedMilliseconds(250),
        ))
        .add_task(task(
            "approve",
            TaskBehavior::Continue,
            TaskDelay::FixedMilliseconds(250),
        ))
        .add_task(task(
            "archive",
            TaskBehavior::End,
            TaskDelay::FixedMilliseconds(250),
        ))
        .add_edge("receive", "inspect")
        .add_edge("inspect", "approve")
        .add_edge("approve", "archive")
        .build()
        .map_err(|error| graph_build_error(&error))
}
