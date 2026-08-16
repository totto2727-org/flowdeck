#![allow(
    clippy::redundant_pub_crate,
    reason = "Private registry functions are shared with sibling service modules."
)]

#[path = "workflows/demo/definition.rs"]
mod demo;
#[path = "workflows/review/definition.rs"]
mod review;
#[path = "workflows/task.rs"]
mod task;

use graph_flow::{Graph, GraphError};
use serde::Serialize;

use crate::WorkflowError;

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

/// Input defaults and bounds owned by one workflow definition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct WorkflowInputDefinition {
    /// Initial label shown in the run form.
    pub default_label: &'static str,
    /// Initial per-node delay shown in the run form.
    pub default_step_delay_ms: u64,
    /// Minimum allowed per-node delay.
    pub min_step_delay_ms: u64,
    /// Maximum allowed per-node delay.
    pub max_step_delay_ms: u64,
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
    /// Workflow-owned run-form defaults and bounds.
    pub input: WorkflowInputDefinition,
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

fn graph_build_error(error: &GraphError) -> WorkflowError {
    WorkflowError::GraphBuild {
        message: error.to_string(),
    }
}
