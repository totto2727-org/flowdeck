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
use crate::{RunInput, WorkflowError};

pub(super) const WORKFLOW_ID: &str = "review-pipeline";

#[derive(Debug, Deserialize, Validate)]
#[serde(deny_unknown_fields)]
struct ReviewInput {
    #[garde(custom(validate_non_blank), length(chars, max = 80))]
    subject: String,
    #[garde(custom(validate_non_blank), length(chars, max = 80))]
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
    limits: None,
};

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
            aria-labelledby="review-run-form-title"
        >
            <div>
                <p
                    class="text-xs font-semibold uppercase tracking-label text-text-muted"
                >
                    "Run selected"
                </p>
                <h3 class="text-xl font-semibold" id="review-run-form-title">
                    "Review pipeline"
                </h3>
            </div>
            <label
                class="grid gap-1 text-sm font-semibold text-text-secondary"
                for="review-subject"
            >
                <span>"Review subject"</span>
                <input
                    class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                    id="review-subject"
                    name="subject"
                    type="text"
                    data-bind="input.subject"
                    required="required"
                    maxlength="80"
                >
            </label>
            <label
                class="grid gap-1 text-sm font-semibold text-text-secondary"
                for="review-reviewer"
            >
                <span>"Reviewer"</span>
                <input
                    class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                    id="review-reviewer"
                    name="reviewer"
                    type="text"
                    data-bind="input.reviewer"
                    required="required"
                    maxlength="80"
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
    json!({ "subject": "release candidate", "reviewer": "local operator" })
}

pub(super) fn parse_input(value: Value) -> Result<RunInput, WorkflowError> {
    let input = serde_json::from_value::<ReviewInput>(value).map_err(|error| {
        WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: {error}"),
        }
    })?;
    input
        .validate()
        .map_err(|error| WorkflowError::InvalidInput {
            message: format!("{WORKFLOW_ID}: {error}"),
        })?;
    let subject = input.subject.trim().to_owned();
    let reviewer = input.reviewer.trim().to_owned();
    let summary = format!("{subject} · reviewer {reviewer}");
    Ok(RunInput::new(
        json!({ "subject": subject, "reviewer": reviewer }),
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
