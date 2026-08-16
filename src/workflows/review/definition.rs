use graph_flow::GraphBuilder;

use super::{
    EdgeSpec, NodeSpec, WorkflowDefinition, WorkflowInputDefinition, graph_build_error,
    task::{TaskBehavior, task},
};
use crate::WorkflowError;

pub(super) const WORKFLOW_ID: &str = "review-pipeline";

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
    input: WorkflowInputDefinition {
        default_label: "manual review run",
        default_step_delay_ms: 250,
        min_step_delay_ms: 100,
        max_step_delay_ms: 2_000,
    },
    nodes: &NODES,
    edges: &EDGES,
};

pub(super) fn build_graph() -> Result<graph_flow::Graph, WorkflowError> {
    GraphBuilder::new(WORKFLOW_ID)
        .add_task(task("receive", TaskBehavior::Continue))
        .add_task(task("inspect", TaskBehavior::Continue))
        .add_task(task("approve", TaskBehavior::Continue))
        .add_task(task("archive", TaskBehavior::End))
        .add_edge("receive", "inspect")
        .add_edge("inspect", "approve")
        .add_edge("approve", "archive")
        .build()
        .map_err(|error| graph_build_error(&error))
}
