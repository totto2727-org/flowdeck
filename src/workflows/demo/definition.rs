use graph_flow::GraphBuilder;

use super::{
    EdgeSpec, NodeSpec, WorkflowDefinition, WorkflowInputDefinition, graph_build_error,
    task::{TaskBehavior, task},
};
use crate::WorkflowError;

pub(super) const WORKFLOW_ID: &str = "demo-workflow";
const BRANCH_KEY: &str = "branch_yes";

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
    input: WorkflowInputDefinition {
        default_label: "manual branch run",
        default_step_delay_ms: 350,
        min_step_delay_ms: 100,
        max_step_delay_ms: 2_000,
    },
    nodes: &NODES,
    edges: &EDGES,
};

pub(super) fn build_graph() -> Result<graph_flow::Graph, WorkflowError> {
    GraphBuilder::new(WORKFLOW_ID)
        .add_task(task("prepare", TaskBehavior::Continue))
        .add_task(task("choose_route", TaskBehavior::Choose))
        .add_task(task("yes_path", TaskBehavior::Continue))
        .add_task(task("fallback_path", TaskBehavior::Continue))
        .add_task(task("converge", TaskBehavior::Continue))
        .add_task(task("complete", TaskBehavior::End))
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
