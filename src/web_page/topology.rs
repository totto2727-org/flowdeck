#![allow(
    clippy::too_many_lines,
    reason = "Topcoat formatting expands declarative component markup without increasing behavior."
)]

mod layout;

use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{EdgeSpec, NodeSpec, RunSnapshot, RunStatus, WorkflowDefinition};

use self::layout::{edge_label_x, edge_label_y, edge_path, node_transform};
use super::presentation::{state_label, state_value};

#[component]
pub(super) async fn workflow_topology(
    definition: &'static WorkflowDefinition,
    run: Option<RunSnapshot>,
) -> Result {
    let run_id = run
        .as_ref()
        .map_or("idle", |snapshot| snapshot.run_id.as_str());
    let description = topology_description(definition, run.as_ref());
    view! {
        <div
            class="max-w-full min-w-0 overflow-x-auto"
            tabindex="0"
            aria-label="Workflow topology, horizontally scrollable on narrow screens"
        >
            <svg
                class="topology block h-auto max-h-[var(--graph-max-block-size)] w-full min-w-[var(--graph-min)]"
                viewBox="0 0 760 300"
                preserveAspectRatio="xMidYMid meet"
                role="group"
                aria-labelledby=(format!("topology-title-{run_id} topology-desc-{run_id}"))
            >
                <title id=(format!("topology-title-{run_id}"))>
                    (format!("{} workflow topology", definition.name))
                </title>
                <desc id=(format!("topology-desc-{run_id}"))>(description)</desc>
                <defs>
                    <marker
                        id=(format!("arrow-{run_id}"))
                        viewBox="0 0 10 10"
                        refX="9"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                    >
                        <path d="M 0 0 L 10 5 L 0 10 z"></path>
                    </marker>
                </defs>
                for edge in definition.edges {
                    workflow_edge(
                        edge: *edge,
                        run: run.clone(),
                        marker_id: format!("arrow-{run_id}")
                    )
                }
                for node in definition.nodes {
                    workflow_node(node: *node, run: run.clone())
                }
            </svg>
        </div>
    }
}

#[component]
async fn workflow_edge(edge: EdgeSpec, run: Option<RunSnapshot>, marker_id: String) -> Result {
    let active = run.as_ref().is_some_and(|snapshot| {
        snapshot.current_edge.as_deref() == Some(edge.id)
            && matches!(snapshot.status, RunStatus::Running)
    });
    let traversed = run
        .as_ref()
        .is_some_and(|snapshot| snapshot.traversed_edges.iter().any(|id| id == edge.id));
    view! {
        if run.is_some() {
            let selection = selection_expression("edge", edge.id);
            let pressed = pressed_expression("edge", edge.id);
            <g
                class="graph-target"
                data-edge-id=(edge.id)
                data-state=(state_value(active, traversed))
                data-attr:data-selected=(pressed.clone())
                data-attr:aria-pressed=(pressed)
                data-on:click=(selection)
                data-on:keydown=(keyboard_expression("edge", edge.id))
                tabindex="0"
                role="button"
                aria-label=(format!("Inspect edge from {} to {}", edge.from, edge.to))
            >
                <path class="edge-hit" d=(edge_path(edge.id))></path>
                <path
                    class="edge"
                    d=(edge_path(edge.id))
                    marker-end=(format!("url(#{marker_id})"))
                ></path>
                <text class="edge-state" x=(edge_label_x(edge.id)) y=(edge_label_y(edge.id))>
                    (state_label(active, traversed))
                </text>
            </g>
        } else {
            <g class="graph-static" data-edge-id=(edge.id) data-state="idle">
                <path class="edge" d=(edge_path(edge.id)) marker-end=(format!("url(#{marker_id})"))></path>
                <text class="edge-state" x=(edge_label_x(edge.id)) y=(edge_label_y(edge.id))>
                    "Idle"
                </text>
            </g>
        }
    }
}

#[component]
async fn workflow_node(node: NodeSpec, run: Option<RunSnapshot>) -> Result {
    let active = run.as_ref().is_some_and(|snapshot| {
        snapshot.current_node.as_deref() == Some(node.id)
            && matches!(snapshot.status, RunStatus::Running)
    });
    let traversed = run
        .as_ref()
        .is_some_and(|snapshot| snapshot.traversed_nodes.iter().any(|id| id == node.id));
    view! {
        if run.is_some() {
            let selection = selection_expression("node", node.id);
            let pressed = pressed_expression("node", node.id);
            <g
                class="graph-target"
                data-node-id=(node.id)
                data-state=(state_value(active, traversed))
                data-attr:data-selected=(pressed.clone())
                data-attr:aria-pressed=(pressed)
                data-on:click=(selection)
                data-on:keydown=(keyboard_expression("node", node.id))
                tabindex="0"
                role="button"
                transform=(node_transform(node.id))
                aria-label=(format!("Inspect {} node", node.label))
            >
                <rect class="node" width="120" height="54" rx="6"></rect>
                <text class="node-label" x="60" y="23" text-anchor="middle">(node.label)</text>
                <text class="node-state" x="60" y="41" text-anchor="middle">
                    (state_label(active, traversed))
                </text>
            </g>
        } else {
            <g
                class="graph-static"
                data-node-id=(node.id)
                data-state="idle"
                transform=(node_transform(node.id))
                aria-label=(format!("{} node", node.label))
            >
                <rect class="node" width="120" height="54" rx="6"></rect>
                <text class="node-label" x="60" y="23" text-anchor="middle">(node.label)</text>
                <text class="node-state" x="60" y="41" text-anchor="middle">"Idle"</text>
            </g>
        }
    }
}

fn topology_description(definition: &WorkflowDefinition, run: Option<&RunSnapshot>) -> String {
    run.map_or_else(
        || {
            format!(
                "{}. No run selected; all nodes and edges are idle.",
                definition.description
            )
        },
        |snapshot| {
            format!(
                "{} status. Current node: {}. Current edge: {}. Traversed route: {}.",
                super::presentation::run_status(snapshot),
                snapshot.current_node.as_deref().unwrap_or("none"),
                snapshot.current_edge.as_deref().unwrap_or("none"),
                snapshot.route_summary
            )
        },
    )
}

fn selection_expression(kind: &str, id: &str) -> String {
    format!("$selectedTraceKind = '{kind}'; $selectedTraceId = '{id}'")
}

fn pressed_expression(kind: &str, id: &str) -> String {
    format!("$selectedTraceKind === '{kind}' && $selectedTraceId === '{id}' ? 'true' : 'false'")
}

fn keyboard_expression(kind: &str, id: &str) -> String {
    format!(
        "(evt.key === 'Enter' || evt.key === ' ') && (evt.preventDefault(), $selectedTraceKind = '{kind}', $selectedTraceId = '{id}')"
    )
}

#[cfg(test)]
mod tests {
    use topcoat::view::view;
    use workflow_console_experiment::workflow_definitions;

    use super::workflow_topology;

    #[tokio::test]
    async fn topology_uses_fluid_width_with_a_viewport_height_cap() {
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        let definition = workflow_definitions()
            .first()
            .expect("a code-defined workflow should exist");
        let rendered = view! {
            workflow_topology(definition: definition, run: None)
        }
        .expect("topology should render")
        .render(&cx);

        assert!(rendered.contains("max-h-[var(--graph-max-block-size)] w-full"));
        assert!(rendered.contains("min-w-[var(--graph-min)]"));
        assert!(rendered.contains("preserveAspectRatio=\"xMidYMid meet\""));
        assert!(!rendered.contains("max-w-["));
    }

    #[tokio::test]
    async fn runless_topology_is_static_instead_of_a_trace_control() {
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        let definition = workflow_definitions()
            .first()
            .expect("a code-defined workflow should exist");
        let rendered = view! {
            workflow_topology(definition: definition, run: None)
        }
        .expect("topology should render")
        .render(&cx);

        assert!(!rendered.contains("role=\"button\""));
        assert!(!rendered.contains("aria-pressed"));
        assert!(!rendered.contains("data-on:click"));
        assert!(!rendered.contains("data-on:keydown"));
    }
}
