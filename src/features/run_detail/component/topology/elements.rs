use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{EdgeSpec, NodeSpec, RunSnapshot, RunStatus, StepId};

use crate::features::presentation::{state_label, state_value};

use super::geometry::{EdgeGeometry, NodeGeometry};

pub(super) struct EdgeElement {
    pub(super) edge: EdgeSpec,
    pub(super) geometry: EdgeGeometry,
    pub(super) run: Option<RunSnapshot>,
    pub(super) marker_id: String,
}

pub(super) struct NodeElement {
    pub(super) node: NodeSpec,
    pub(super) geometry: NodeGeometry,
    pub(super) run: Option<RunSnapshot>,
}

#[component]
pub(super) async fn workflow_edge(model: EdgeElement) -> Result {
    let edge = model.edge;
    let geometry = model.geometry;
    let run = model.run;
    let marker_id = model.marker_id;
    let active = run.as_ref().is_some_and(|snapshot| {
        snapshot.current_edge.as_deref() == Some(edge.id)
            && matches!(snapshot.status, RunStatus::Running)
    });
    let traversed = run
        .as_ref()
        .is_some_and(|snapshot| snapshot.traversed_edges.iter().any(|id| id == edge.id));
    let traversal_count = run.as_ref().map_or(0, |snapshot| {
        snapshot
            .traversed_edges
            .iter()
            .filter(|id| id.as_str() == edge.id)
            .count()
    });
    let latest_step_id = run.as_ref().and_then(|snapshot| {
        snapshot
            .steps
            .iter()
            .rev()
            .find(|step| step.selected_edge.as_deref() == Some(edge.id))
            .map(|step| step.step_id)
    });
    view! {
        if run.is_some() {
            let selection = selection_expression("edge", edge.id, latest_step_id);
            let pressed = pressed_expression("edge", edge.id);
            <g
                class="graph-target"
                data-edge-id=(edge.id)
                data-state=(state_value(active, traversed))
                data-attr:data-selected=(pressed.clone())
                data-attr:aria-pressed=(pressed)
                data-on:click=(selection)
                data-on:keydown=(keyboard_expression("edge", edge.id, latest_step_id))
                tabindex="0"
                role="button"
                aria-label=(format!("Inspect edge from {} to {}", edge.from, edge.to))
            >
                <path class="edge-hit" d=(geometry.path.clone())></path>
                <path class="edge" d=(geometry.path.clone()) marker-end=(format!("url(#{marker_id})"))></path>
                <text class="edge-state" x=(geometry.label_x) y=(geometry.label_y)>
                    (counted_state_label(active, traversed, traversal_count))
                </text>
            </g>
        } else {
            <g class="graph-static" data-edge-id=(edge.id) data-state="idle">
                <path class="edge" d=(geometry.path.clone()) marker-end=(format!("url(#{marker_id})"))></path>
                <text class="edge-state" x=(geometry.label_x) y=(geometry.label_y)>"Idle"</text>
            </g>
        }
    }
}

#[component]
pub(super) async fn workflow_node(model: NodeElement) -> Result {
    let node = model.node;
    let geometry = model.geometry;
    let run = model.run;
    let transform = format!("translate({} {})", geometry.x, geometry.y);
    let active = run.as_ref().is_some_and(|snapshot| {
        snapshot.current_node.as_deref() == Some(node.id)
            && matches!(snapshot.status, RunStatus::Running)
    });
    let traversed = run
        .as_ref()
        .is_some_and(|snapshot| snapshot.traversed_nodes.iter().any(|id| id == node.id));
    let execution_count = run.as_ref().map_or(0, |snapshot| {
        snapshot
            .steps
            .iter()
            .filter(|step| step.node_id == node.id)
            .count()
    });
    let latest_step_id = run.as_ref().and_then(|snapshot| {
        snapshot
            .steps
            .iter()
            .rev()
            .find(|step| step.node_id == node.id)
            .map(|step| step.step_id)
    });
    view! {
        if run.is_some() {
            let selection = selection_expression("node", node.id, latest_step_id);
            let pressed = pressed_expression("node", node.id);
            <g
                class="graph-target"
                data-node-id=(node.id)
                data-state=(state_value(active, traversed))
                data-attr:data-selected=(pressed.clone())
                data-attr:aria-pressed=(pressed)
                data-on:click=(selection)
                data-on:keydown=(keyboard_expression("node", node.id, latest_step_id))
                tabindex="0"
                role="button"
                transform=(transform.clone())
                aria-label=(format!("Inspect {} node", node.label))
            >
                <rect class="node" width=(geometry.width) height=(geometry.height) rx="6"></rect>
                <text class="node-label" x="60" y="23" text-anchor="middle">(node.label)</text>
                <text class="node-state" x="60" y="41" text-anchor="middle">
                    (counted_state_label(active, traversed, execution_count))
                </text>
                if execution_count > 0 {
                    <text class="node-count" x="110" y="12" text-anchor="end">(format!("×{execution_count}"))</text>
                }
            </g>
        } else {
            <g class="graph-static" data-node-id=(node.id) data-state="idle" transform=(transform) aria-label=(format!("{} node", node.label))>
                <rect class="node" width=(geometry.width) height=(geometry.height) rx="6"></rect>
                <text class="node-label" x="60" y="23" text-anchor="middle">(node.label)</text>
                <text class="node-state" x="60" y="41" text-anchor="middle">"Idle"</text>
            </g>
        }
    }
}

fn selection_expression(kind: &str, id: &str, step_id: Option<StepId>) -> String {
    let step = step_id.map_or_else(String::new, |step_id| step_id.to_string());
    format!(
        "$selectedTraceKind = '{kind}'; $selectedTraceId = '{id}'; $selectedStepId = '{step}'; $traceFollowLatest = true"
    )
}

fn pressed_expression(kind: &str, id: &str) -> String {
    format!("$selectedTraceKind === '{kind}' && $selectedTraceId === '{id}' ? 'true' : 'false'")
}

fn keyboard_expression(kind: &str, id: &str, step_id: Option<StepId>) -> String {
    let selection = selection_expression(kind, id, step_id);
    format!("(evt.key === 'Enter' || evt.key === ' ') && (evt.preventDefault(), {selection})")
}

fn counted_state_label(active: bool, traversed: bool, count: usize) -> String {
    let state = state_label(active, traversed);
    if count == 0 {
        state.to_owned()
    } else {
        format!("{state} ×{count}")
    }
}
