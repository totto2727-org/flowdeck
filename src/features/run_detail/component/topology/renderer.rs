use topcoat::{
    Result,
    context::Cx,
    view::{View, component, view},
};
use workflow_console_experiment::{RunSnapshot, WorkflowDefinition};

use crate::features::presentation::run_status;

use super::{
    elements::{EdgeElement, NodeElement, workflow_edge, workflow_node},
    geometry::{LayeredAutoLayout, TopologyLayoutEngine},
};

pub(super) trait TopologyRenderer: Send + Sync {
    async fn render(&self, cx: &Cx, model: TopologyRenderModel) -> Result<View>;
}

pub(super) struct TopologyRenderModel {
    definition: &'static WorkflowDefinition,
    run: Option<RunSnapshot>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct SvgTopologyRenderer;

const TOPOLOGY_RENDERER: SvgTopologyRenderer = SvgTopologyRenderer;

#[component]
pub(crate) async fn workflow_topology(
    definition: &'static WorkflowDefinition,
    run: Option<RunSnapshot>,
) -> Result {
    TOPOLOGY_RENDERER
        .render(__cx, TopologyRenderModel { definition, run })
        .await
}

impl TopologyRenderer for SvgTopologyRenderer {
    async fn render(&self, cx: &Cx, model: TopologyRenderModel) -> Result<View> {
        let __cx = cx;
        let definition = model.definition;
        let run = model.run;
        let layout = LayeredAutoLayout.layout(definition);
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
                    viewBox=(format!("0 0 {} {}", layout.view_box.width, layout.view_box.height))
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
                        if let Some(geometry) = layout.edge(edge.id) {
                            workflow_edge(
                                model: EdgeElement {
                                    edge: *edge,
                                    geometry: geometry.clone(),
                                    run: run.clone(),
                                    marker_id: format!("arrow-{run_id}"),
                                }
                            )
                        }
                    }
                    for node in definition.nodes {
                        if let Some(geometry) = layout.node(node.id) {
                            workflow_node(model: NodeElement {
                                node: *node,
                                geometry: *geometry,
                                run: run.clone(),
                            })
                        }
                    }
                </svg>
            </div>
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
                run_status(snapshot),
                snapshot.current_node.as_deref().unwrap_or("none"),
                snapshot.current_edge.as_deref().unwrap_or("none"),
                snapshot.route_summary
            )
        },
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
        assert!(!rendered.contains("viewBox=\"0 0 760 300\""));
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

    #[tokio::test]
    async fn every_registered_workflow_uses_computed_nonzero_geometry() {
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        for definition in workflow_definitions() {
            let rendered = view! {
                workflow_topology(definition: definition, run: None)
            }
            .expect("registered topology should render")
            .render(&cx);

            assert!(!rendered.contains("translate(0 0)"));
            assert!(!rendered.contains("class=\"edge\" d=\"M 0 0\""));
        }
    }
}
