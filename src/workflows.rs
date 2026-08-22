#![allow(
    clippy::redundant_pub_crate,
    clippy::exhaustive_structs,
    unreachable_pub,
    reason = "Private registry functions and Topcoat-generated props cross sibling and package crate boundaries."
)]

#[path = "workflows/demo/definition.rs"]
mod demo;
mod jcode_translation;
#[path = "workflows/review/definition.rs"]
mod review;
#[path = "workflows/task.rs"]
mod task;

pub(crate) use jcode_translation::launch_runtime as launch_jcode_runtime;

use graph_flow::{Graph, GraphError};
use graph_flow_jcode::JcodeRuntime;
use serde::Serialize;
use serde_json::Value;
use topcoat::{
    Result,
    view::{component, view},
};

use crate::{RunInput, ScheduleSpec, WorkflowError, WorkflowExecutionLimits};
use std::sync::Arc;

pub(crate) const INPUT_SUMMARY_KEY: &str = "input_summary";
pub(crate) const WORKFLOW_INPUT_KEY: &str = "workflow_input";

/// A code-defined graph node retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct NodeSpec {
    /// Stable task ID.
    pub id: &'static str,
    /// Short UI-facing label.
    pub label: &'static str,
}

/// A code-defined graph edge retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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
    /// Optional workflow-specific override for execution bounds.
    pub limits: Option<WorkflowExecutionLimits>,
}

impl WorkflowDefinition {
    /// Resolve the workflow override or derive strict application defaults from its node count.
    pub fn execution_limits(&self) -> Result<WorkflowExecutionLimits, WorkflowError> {
        self.limits.map_or_else(
            || WorkflowExecutionLimits::defaults(self.nodes.len()),
            WorkflowExecutionLimits::validated,
        )
    }
}

const DEFINITIONS: [WorkflowDefinition; 3] = [
    demo::DEFINITION,
    review::DEFINITION,
    jcode_translation::DEFINITION,
];

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
        jcode_translation::WORKFLOW_ID => view! { jcode_translation::input_form(active: active) },
        _ => view! { <p class="request-error">"Workflow input form is unavailable."</p> },
    }
}

/// Return the input defaults owned by one registered workflow.
pub fn workflow_default_input(workflow_id: &str) -> Value {
    match workflow_id {
        demo::WORKFLOW_ID => demo::default_input(),
        review::WORKFLOW_ID => review::default_input(),
        jcode_translation::WORKFLOW_ID => jcode_translation::default_input(),
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

pub(crate) fn build_graph(
    workflow_id: &str,
    jcode_runtime: Option<Arc<JcodeRuntime>>,
) -> Result<Graph, WorkflowError> {
    match workflow_id {
        demo::WORKFLOW_ID => demo::build_graph(),
        review::WORKFLOW_ID => review::build_graph(),
        jcode_translation::WORKFLOW_ID => jcode_translation::build_graph(jcode_runtime),
        _ => Err(WorkflowError::UnknownWorkflow {
            workflow_id: workflow_id.to_owned(),
        }),
    }
}

pub(crate) fn parse_input(workflow_id: &str, input: Value) -> Result<RunInput, WorkflowError> {
    match workflow_id {
        demo::WORKFLOW_ID => demo::parse_input(input),
        review::WORKFLOW_ID => review::parse_input(input),
        jcode_translation::WORKFLOW_ID => jcode_translation::parse_input(input),
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
        review::WORKFLOW_ID | jcode_translation::WORKFLOW_ID => {
            Err(WorkflowError::UnknownSchedule {
                schedule_id: schedule_id.to_owned(),
            })
        }
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
