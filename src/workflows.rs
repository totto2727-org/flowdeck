#![allow(
    clippy::redundant_pub_crate,
    clippy::exhaustive_structs,
    unreachable_pub,
    reason = "Private registry functions and Topcoat-generated props cross sibling and package crate boundaries."
)]

#[path = "workflows/demo/definition.rs"]
mod demo;
mod jcode_translation;
mod registration;
#[path = "workflows/review/definition.rs"]
mod review;
#[path = "workflows/task.rs"]
mod task;

use graph_flow::GraphError;
use serde_json::Value;
use topcoat::{
    Result,
    view::{component, view},
};

use crate::{ScheduleSpec, WorkflowError, WorkflowExecutionLimits};
use std::collections::HashSet;

pub(crate) use registration::{TraceProjector, WorkflowInputContract, WorkflowRegistration};

pub(crate) const INPUT_SUMMARY_KEY: &str = "input_summary";
pub(crate) const WORKFLOW_INPUT_KEY: &str = "workflow_input";
pub(crate) const WORKFLOW_RUN_ID_KEY: &str = "workflow_run_id";

/// A code-defined graph node retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeSpec {
    /// Stable task ID.
    pub id: &'static str,
    /// Short UI-facing label.
    pub label: &'static str,
}

/// A code-defined graph edge retained independently from graph-flow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgeSpec {
    /// Stable edge ID.
    pub id: &'static str,
    /// Source task ID.
    pub from: &'static str,
    /// Target task ID.
    pub to: &'static str,
}

/// One workflow definition compiled into the local application.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    pub fn execution_limits(
        &self,
        defaults: &crate::WorkflowExecutionDefaults,
    ) -> Result<WorkflowExecutionLimits, WorkflowError> {
        self.limits.map_or_else(
            || WorkflowExecutionLimits::defaults(self.nodes.len(), defaults),
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

/// Revalidate known workflow inputs without constructing graphs or live resources.
/// Historical inputs for removed workflows remain opaque read-only payloads.
pub(crate) fn restore_run_input(
    workflow_id: &str,
    value: Value,
    summary: String,
) -> Result<crate::RunInput, WorkflowError> {
    match workflow_id {
        demo::WORKFLOW_ID => demo::parse_input(value),
        review::WORKFLOW_ID => review::parse_input(value),
        jcode_translation::WORKFLOW_ID => jcode_translation::parse_input(value),
        _ => Ok(crate::RunInput::new(value, summary)),
    }
}

pub(crate) const fn default_definition() -> &'static WorkflowDefinition {
    &demo::DEFINITION
}

pub(crate) fn workflow_registrations() -> Result<Vec<WorkflowRegistration>, WorkflowError> {
    let registrations = vec![
        WorkflowRegistration::new(
            &demo::DEFINITION,
            demo::build_graph()?,
            demo::parse_input,
            demo::scheduled_input,
            task::project_trace,
        ),
        WorkflowRegistration::new(
            &review::DEFINITION,
            review::build_graph()?,
            review::parse_input,
            registration::no_scheduled_input,
            task::project_trace,
        ),
        jcode_translation::registration()?,
    ];
    validate_registrations(&registrations)?;
    Ok(registrations)
}

pub(crate) const fn schedules() -> &'static [ScheduleSpec] {
    &demo::SCHEDULES
}

fn validate_registrations(registrations: &[WorkflowRegistration]) -> Result<(), WorkflowError> {
    let mut ids = HashSet::with_capacity(registrations.len());
    for registration in registrations {
        if !ids.insert(registration.definition.workflow_id) {
            return Err(WorkflowError::GraphBuild {
                message: format!(
                    "duplicate workflow registration: {}",
                    registration.definition.workflow_id
                ),
            });
        }
    }
    Ok(())
}

fn graph_build_error(error: &GraphError) -> WorkflowError {
    WorkflowError::GraphBuild {
        message: error.to_string(),
    }
}
