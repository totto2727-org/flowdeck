use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{RunSnapshot, RunStatus, WorkflowDefinition};

use crate::web_page::presentation::{elapsed, run_status, trigger};

use super::topology::workflow_topology;

#[component]
pub(super) async fn workflow_graph_panel(
    definition: &'static WorkflowDefinition,
    run: Option<RunSnapshot>,
) -> Result {
    let title_id = run.as_ref().map_or_else(
        || format!("inspector-title-{}", definition.workflow_id),
        |snapshot| format!("inspector-title-{}", snapshot.run_id),
    );
    let status = run.as_ref().map_or("Idle", run_status);
    view! {
        <div class="flex items-start justify-between gap-4">
            <div>
                <p class="text-xs font-semibold uppercase tracking-label text-text-muted">
                    if run.is_some() {
                        "Selected run"
                    } else {
                        "Selected workflow"
                    }
                </p>
                <h2 class="text-xl font-semibold" id=(title_id)>(definition.name)</h2>
            </div>
            <p
                class="rounded-control border border-current px-2 py-1 text-sm font-semibold text-text-secondary data-[status=Running]:text-status-healthy data-[status=Completed]:text-status-healthy data-[status=Failed]:text-status-error"
                data-status=(status)
                role="status"
                aria-live="polite"
            >
                (status)
            </p>
        </div>
        if let Some(run) = run.as_ref() {
            run_metadata(run: run)
            if let RunStatus::Failed { message } = &run.status {
                <p
                    class="mb-4 border-l-[var(--error-border)] border-status-error bg-surface-elevated p-3"
                    role="alert"
                >
                    (message)
                </p>
            }
        }
        topology_legend()
        workflow_topology(definition: definition, run: run)
    }
}

#[component]
async fn run_metadata(run: &RunSnapshot) -> Result {
    view! {
        <dl
            class="my-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(var(--summary-min),1fr)]"
        >
            <div>
                <dt class="text-xs font-semibold text-text-muted">"Workflow"</dt>
                <dd class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]">
                    (run.workflow_id.clone())
                </dd>
            </div>
            <div>
                <dt class="text-xs font-semibold text-text-muted">"Trigger"</dt>
                <dd class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]">
                    (trigger(run))
                </dd>
            </div>
            <div>
                <dt class="text-xs font-semibold text-text-muted">"Input"</dt>
                <dd class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]">
                    (run.input.summary())
                </dd>
            </div>
            <div>
                <dt class="text-xs font-semibold text-text-muted">"Elapsed"</dt>
                <dd class="mt-1 font-mono text-[length:var(--type-code)]">(elapsed(run))</dd>
            </div>
            <div class="lg:col-span-2">
                <dt class="text-xs font-semibold text-text-muted">"Route"</dt>
                <dd
                    class="mt-1 break-normal font-mono text-[length:var(--type-code)]"
                    data-testid="route-summary"
                >
                    (run.route_summary.clone())
                </dd>
            </div>
        </dl>
    }
}

#[component]
async fn topology_legend() -> Result {
    view! {
        <div
            class="mb-3 flex flex-wrap gap-4 text-sm text-text-secondary"
            aria-label="Topology state legend"
        >
            <span class="inline-flex items-center gap-2">
                <i class="size-3 rounded-full border border-text-muted"></i>
                "Idle"
            </span>
            <span class="inline-flex items-center gap-2">
                <i class="size-3 rounded-full border border-status-healthy bg-status-healthy"></i>
                "Active"
            </span>
            <span class="inline-flex items-center gap-2">
                <i class="size-3 rounded-full border border-accent-hover bg-accent-hover"></i>
                "Traversed"
            </span>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use topcoat::view::view;
    use workflow_console_experiment::{RunTrigger, WorkflowService, workflow_definitions};

    use super::{super::inspector::run_inspector, workflow_graph_panel};

    #[tokio::test]
    async fn graph_panel_without_a_run_renders_only_static_workflow_context() {
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        let definition = workflow_definitions()
            .first()
            .expect("a code-defined workflow should exist");
        let rendered = view! {
            workflow_graph_panel(definition: definition, run: None)
        }
        .expect("runless graph panel should render")
        .render(&cx);

        assert!(rendered.contains("Selected workflow"));
        assert!(rendered.contains("Topology state legend"));
        assert!(!rendered.contains("Selected run"));
        assert!(!rendered.contains("data-testid=\"route-summary\""));
        assert!(!rendered.contains("Step trace"));
        assert!(!rendered.contains("role=\"button\""));
    }

    #[tokio::test]
    async fn graph_panel_with_a_run_keeps_interactive_trace_selection_and_metadata() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        let run = service
            .start(
                "review-pipeline",
                json!({ "subject": "render", "reviewer": "qa" }),
                RunTrigger::Manual,
            )
            .await
            .expect("review workflow should start");
        let definition = workflow_definitions()
            .iter()
            .find(|definition| definition.workflow_id == run.workflow_id)
            .expect("started workflow should have a definition");
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        let rendered = view! {
            workflow_graph_panel(definition: definition, run: Some(run))
        }
        .expect("run graph panel should render")
        .render(&cx);

        assert!(rendered.contains("Selected run"));
        assert!(rendered.contains("data-testid=\"route-summary\""));
        assert!(rendered.contains("role=\"button\""));
        assert!(rendered.contains("aria-pressed"));
        assert!(rendered.contains("data-on:keydown"));
    }

    #[tokio::test]
    async fn run_inspector_composes_the_graph_panel_with_step_trace_details() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        let run = service
            .start(
                "review-pipeline",
                json!({ "subject": "composition", "reviewer": "qa" }),
                RunTrigger::Manual,
            )
            .await
            .expect("review workflow should start");
        let run_id = run.run_id.to_string();
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        let rendered = view! {
            run_inspector(run: run)
        }
        .expect("run inspector should render")
        .render(&cx);

        assert!(rendered.contains(&format!("id=\"run-{run_id}-inspector\"")));
        assert!(rendered.contains("data-testid=\"route-summary\""));
        assert!(rendered.contains("role=\"button\""));
        assert!(rendered.contains("data-testid=\"trace-state\""));
        assert!(rendered.contains("data-testid=\"trace-output\""));
    }
}
