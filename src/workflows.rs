#![allow(
    clippy::redundant_pub_crate,
    clippy::exhaustive_structs,
    unreachable_pub,
    reason = "Private registry functions and Topcoat-generated props cross sibling and package crate boundaries."
)]

#[path = "workflows/demo/definition.rs"]
mod demo;
#[path = "workflows/review/definition.rs"]
mod review;
#[path = "workflows/task.rs"]
mod task;

use graph_flow::{Graph, GraphError};
use serde::Serialize;
use serde_json::Value;
use topcoat::{
    Result,
    view::{component, view},
};

use crate::{RunInput, ScheduleSpec, WorkflowError};

pub(crate) const INPUT_SUMMARY_KEY: &str = "input_summary";
pub(crate) const WORKFLOW_INPUT_KEY: &str = "workflow_input";

/// A code-defined graph node retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct NodeSpec {
    /// Stable task ID.
    pub id: &'static str,
    /// Short UI-facing label.
    pub label: &'static str,
}

/// A code-defined graph edge retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct EdgeSpec {
    /// Stable edge ID.
    pub id: &'static str,
    /// Source task ID.
    pub from: &'static str,
    /// Target task ID.
    pub to: &'static str,
}

/// One workflow definition compiled into the local application.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct WorkflowDefinition {
    /// Stable workflow ID accepted by the execution boundary.
    pub workflow_id: &'static str,
    /// Human-readable workflow name.
    pub name: &'static str,
    /// Short purpose statement for selection UI.
    pub description: &'static str,
    /// First graph task.
    pub start_node: &'static str,
    /// Immutable topology nodes.
    pub nodes: &'static [NodeSpec],
    /// Immutable topology edges.
    pub edges: &'static [EdgeSpec],
}

const DEFINITIONS: [WorkflowDefinition; 2] = [demo::DEFINITION, review::DEFINITION];

/// Return every workflow compiled into the local application.
pub const fn workflow_definitions() -> &'static [WorkflowDefinition] {
    &DEFINITIONS
}

#[component]
/// Render the input form owned by one registered workflow.
pub async fn workflow_input_form(workflow_id: &str, active: bool) -> Result {
    match workflow_id {
        demo::WORKFLOW_ID => view! { demo::input_form(active: active) },
        review::WORKFLOW_ID => view! { review::input_form(active: active) },
        _ => view! { <p class="request-error">"Workflow input form is unavailable."</p> },
    }
}

/// Return the input defaults owned by one registered workflow.
pub fn workflow_default_input(workflow_id: &str) -> Value {
    match workflow_id {
        demo::WORKFLOW_ID => demo::default_input(),
        review::WORKFLOW_ID => review::default_input(),
        _ => Value::Object(serde_json::Map::new()),
    }
}

pub(crate) const fn default_definition() -> &'static WorkflowDefinition {
    &demo::DEFINITION
}

pub(crate) fn definition(workflow_id: &str) -> Option<&'static WorkflowDefinition> {
    DEFINITIONS
        .iter()
        .find(|definition| definition.workflow_id == workflow_id)
}

pub(crate) fn build_graph(workflow_id: &str) -> Result<Graph, WorkflowError> {
    match workflow_id {
        demo::WORKFLOW_ID => demo::build_graph(),
        review::WORKFLOW_ID => review::build_graph(),
        _ => Err(WorkflowError::UnknownWorkflow {
            workflow_id: workflow_id.to_owned(),
        }),
    }
}

pub(crate) fn parse_input(workflow_id: &str, input: Value) -> Result<RunInput, WorkflowError> {
    match workflow_id {
        demo::WORKFLOW_ID => demo::parse_input(input),
        review::WORKFLOW_ID => review::parse_input(input),
        _ => Err(WorkflowError::UnknownWorkflow {
            workflow_id: workflow_id.to_owned(),
        }),
    }
}

pub(crate) const fn schedules() -> &'static [ScheduleSpec] {
    &demo::SCHEDULES
}

pub(crate) fn scheduled_input(
    workflow_id: &str,
    schedule_id: &str,
) -> Result<Value, WorkflowError> {
    match workflow_id {
        demo::WORKFLOW_ID => demo::scheduled_input(schedule_id),
        review::WORKFLOW_ID => Err(WorkflowError::UnknownSchedule {
            schedule_id: schedule_id.to_owned(),
        }),
        _ => Err(WorkflowError::UnknownWorkflow {
            workflow_id: workflow_id.to_owned(),
        }),
    }
}

fn graph_build_error(error: &GraphError) -> WorkflowError {
    WorkflowError::GraphBuild {
        message: error.to_string(),
    }
}
