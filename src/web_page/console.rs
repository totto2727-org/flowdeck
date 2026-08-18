mod graph_panel;

use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{RunSnapshot, workflow_definitions};

use self::graph_panel::workflow_graph_panel;
use super::{
    history::{HistoryPanelState, history_panel},
    trace::run_traces,
};

#[component]
pub(super) async fn console_content(
    selected_workflow_id: &str,
    selected: Option<RunSnapshot>,
    history: HistoryPanelState,
) -> Result {
    view! {
        <div id="console-content" class="grid min-w-0 gap-4">
            selected_inspector_host(
                selected_workflow_id: selected_workflow_id,
                run: selected
            )
            history_panel(state: history)
        </div>
    }
}

#[component]
pub(super) async fn selected_inspector_host(
    selected_workflow_id: &str,
    run: Option<RunSnapshot>,
) -> Result {
    let events_url = run
        .as_ref()
        .map(|run| format!("/events/runs/{}", run.run_id));
    view! {
        <div
            id="selected-inspector-host"
            class="min-w-0"
            data-init=(events_url.map(|url| format!("@get('{url}')")))
        >
            if let Some(run) = run {
                run_inspector(run: run)
            } else {
                idle_inspector(selected_workflow_id: selected_workflow_id)
            }
        </div>
    }
}

#[component]
async fn idle_inspector(selected_workflow_id: &str) -> Result {
    view! {
        for definition in workflow_definitions()
            .iter()
            .filter(|definition| definition.workflow_id == selected_workflow_id) {
            <section
                class="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-panel"
                aria-labelledby=(format!("inspector-title-{}", definition.workflow_id))
            >
                workflow_graph_panel(definition: definition, run: None)
            </section>
        }
    }
}

#[component]
pub(super) async fn run_inspector(run: RunSnapshot) -> Result {
    let run_id = run.run_id.to_string();
    let definition = workflow_definitions()
        .iter()
        .find(|definition| definition.workflow_id == run.workflow_id);
    view! {
        <section
            id=(format!("run-{run_id}-inspector"))
            class="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-panel"
            aria-labelledby=(format!("inspector-title-{run_id}"))
        >
            if let Some(definition) = definition {
                workflow_graph_panel(definition: definition, run: Some(run.clone()))
            }
            run_traces(run: run)
        </section>
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn selected_inspector_without_a_run_renders_one_graph_and_no_run_stream() {
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        let html = topcoat::view::view! {
            super::selected_inspector_host(
                selected_workflow_id: "review-pipeline",
                run: None
            )
        }
        .expect("runless inspector should render")
        .render(&cx);

        assert_eq!(html.matches("<svg").count(), 1);
        assert!(!html.contains("/events/runs/"));
        assert!(!html.contains("Step trace"));
    }
}
