use workflow_console_experiment::{EdgeSpec, NodeSpec, WorkflowDefinition};

use super::{LayeredAutoLayout, TopologyLayoutEngine};

const NODES: [NodeSpec; 2] = [
    NodeSpec {
        id: "work",
        label: "Work",
    },
    NodeSpec {
        id: "done",
        label: "Done",
    },
];
const EDGES: [EdgeSpec; 2] = [
    EdgeSpec {
        id: "retry",
        from: "work",
        to: "work",
    },
    EdgeSpec {
        id: "finish",
        from: "work",
        to: "done",
    },
];
const DEFINITION: WorkflowDefinition = WorkflowDefinition {
    workflow_id: "layout-test",
    name: "Layout test",
    description: "Self-loop layout fixture.",
    start_node: "work",
    nodes: &NODES,
    edges: &EDGES,
    limits: None,
};

#[test]
fn layered_layout_positions_every_node_and_routes_self_edges_outside() {
    // Given: a graph with an arbitrary node ID and one self-reference.
    let layout = LayeredAutoLayout.layout(&DEFINITION);

    // When: node and edge geometry is inspected by ID.
    let work = layout.node("work").expect("work node should be positioned");
    let done = layout.node("done").expect("done node should be positioned");
    let retry = layout.edge("retry").expect("self edge should be routed");

    // Then: positions are distinct and the loop rises outside the node box.
    assert_ne!(work.x, done.x);
    assert!(retry.path.contains('C'));
    assert!(retry.label_y < work.y);
    assert!(layout.view_box.width > done.x);
    assert!(layout.view_box.height > work.height);
}
