#![allow(
    clippy::too_many_lines,
    reason = "Topcoat formatting expands declarative component markup without increasing behavior."
)]

use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{RunSnapshot, WorkflowDefinition};

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
                    let active = run
                        .as_ref()
                        .and_then(|snapshot| snapshot.current_edge.as_deref())
                        == Some(edge.id)
                        && run
                            .as_ref()
                            .is_some_and(|snapshot| {
                                matches!(
                                    snapshot.status,
                                    workflow_console_experiment::RunStatus::Running
                                )
                            });
                    let traversed = run
                        .as_ref()
                        .is_some_and(|snapshot| {
                            snapshot.traversed_edges.iter().any(|id| id == edge.id)
                        });
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
                        aria-label=(format!(
                            "Inspect edge from {} to {}", edge.from, edge.to
                        ))
                    >
                        <path class="edge-hit" d=(edge_path(edge.id))></path>
                        <path
                            class="edge"
                            d=(edge_path(edge.id))
                            marker-end=(format!("url(#arrow-{run_id})"))
                        ></path>
                        <text
                            class="edge-state"
                            x=(edge_label_x(edge.id))
                            y=(edge_label_y(edge.id))
                        >
                            (state_label(active, traversed))
                        </text>
                    </g>
                }
                for node in definition.nodes {
                    let active = run
                        .as_ref()
                        .and_then(|snapshot| snapshot.current_node.as_deref())
                        == Some(node.id)
                        && run
                            .as_ref()
                            .is_some_and(|snapshot| {
                                matches!(
                                    snapshot.status,
                                    workflow_console_experiment::RunStatus::Running
                                )
                            });
                    let traversed = run
                        .as_ref()
                        .is_some_and(|snapshot| {
                            snapshot.traversed_nodes.iter().any(|id| id == node.id)
                        });
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
                        <text class="node-label" x="60" y="23" text-anchor="middle">
                            (node.label)
                        </text>
                        <text class="node-state" x="60" y="41" text-anchor="middle">
                            (state_label(active, traversed))
                        </text>
                    </g>
                }
            </svg>
        </div>
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

fn node_transform(id: &str) -> &'static str {
    match id {
        "prepare" => "translate(20 123)",
        "choose_route" => "translate(170 123)",
        "yes_path" => "translate(330 42)",
        "fallback_path" => "translate(330 204)",
        "converge" => "translate(490 123)",
        "complete" => "translate(640 123)",
        "receive" => "translate(50 123)",
        "inspect" => "translate(230 123)",
        "approve" => "translate(410 123)",
        "archive" => "translate(590 123)",
        _ => "translate(0 0)",
    }
}

fn edge_path(id: &str) -> &'static str {
    match id {
        "prepare-to-choose" => "M 140 150 L 170 150",
        "choose-to-yes" => "M 290 144 C 305 144 305 69 330 69",
        "choose-to-fallback" => "M 290 156 C 305 156 305 231 330 231",
        "yes-to-converge" => "M 450 69 C 475 69 475 144 490 144",
        "fallback-to-converge" => "M 450 231 C 475 231 475 156 490 156",
        "converge-to-complete" => "M 610 150 L 640 150",
        "receive-to-inspect" => "M 170 150 L 230 150",
        "inspect-to-approve" => "M 350 150 L 410 150",
        "approve-to-archive" => "M 530 150 L 590 150",
        _ => "M 0 0",
    }
}

fn edge_label_x(id: &str) -> &'static str {
    match id {
        "prepare-to-choose" => "142",
        "choose-to-yes" | "choose-to-fallback" => "294",
        "yes-to-converge" | "fallback-to-converge" => "452",
        "converge-to-complete" => "612",
        "receive-to-inspect" => "180",
        "inspect-to-approve" => "360",
        "approve-to-archive" => "540",
        _ => "0",
    }
}
fn edge_label_y(id: &str) -> &'static str {
    match id {
        "choose-to-yes" | "yes-to-converge" => "94",
        "choose-to-fallback" | "fallback-to-converge" => "218",
        "prepare-to-choose"
        | "converge-to-complete"
        | "receive-to-inspect"
        | "inspect-to-approve"
        | "approve-to-archive" => "173",
        _ => "0",
    }
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
}
