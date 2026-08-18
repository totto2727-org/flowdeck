mod console;
mod presentation;
mod routes;
mod topology;
mod trace;

use serde::Serialize;
use serde_json::Value;
use topcoat::{
    Result,
    asset::{Asset, asset},
    context::Cx,
    router::{
        StatusCode,
        error::{NotFoundError, not_found as not_found_error},
        layout, page,
    },
    view::{component, view},
};
use workflow_console_experiment::{
    RunSnapshot, WorkflowService, workflow_default_input, workflow_definitions,
    workflow_input_form, workflow_schedules,
};

use self::console::{
    console_content, recovery_inspector_host, run_history, run_inspector, selected_inspector_host,
};
#[allow(
    clippy::redundant_pub_crate,
    reason = "The route action sibling uses this private page URL formatter."
)]
pub(crate) use self::routes::workflow_url;
use crate::history_filter::{HistoryFilterValues, HistoryFilters};

const DATASTAR_JS: Asset =
    asset!("https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.2/bundles/datastar.js");
const NOT_FOUND_REDIRECT_DELAY_SECONDS: u8 = 2;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitialSignals {
    selected_workflow_id: String,
    selected_run_id: String,
    selected_trace_kind: &'static str,
    selected_trace_id: String,
    #[serde(flatten)]
    history: HistoryFilterValues,
    input: Value,
    request_message: &'static str,
}

#[layout("/")]
async fn root_layout(cx: &Cx, slot: Result) -> Result {
    match slot {
        Err(error) if error.downcast_ref::<NotFoundError>().is_some() => {
            not_found_document(cx).await
        }
        content => content,
    }
}

#[page("/{*missing_path}")]
async fn missing_page() -> Result {
    Err(not_found_error().into())
}

async fn render_console_page(
    cx: &Cx,
    selected_workflow_id: &str,
    selected_run: Option<RunSnapshot>,
    runs: Vec<RunSnapshot>,
    filters: &HistoryFilters,
) -> Result {
    let __cx = cx;
    let signals = initial_signals(selected_workflow_id, selected_run.as_ref(), filters);
    let signals_json = serde_json::to_string(&signals)?;
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta
                    name="description"
                    content="Inspect and run local code-defined workflows"
                >
                <link rel="stylesheet" href=(topcoat::tailwind::stylesheet!())>
                <script type="module" src=(DATASTAR_JS)></script>
                <title>"Workflow Console"</title>
            </head>
            <body data-signals=(signals_json) data-init="@get('/events')">
                <header
                    class="flex items-start justify-between gap-4 border-b border-border bg-surface px-4 py-4 lg:items-center lg:px-8"
                >
                    <div>
                        <p
                            class="text-xs font-semibold uppercase tracking-label text-text-muted"
                        >
                            "Local operations"
                        </p>
                        <h1 class="text-3xl font-semibold tracking-title">
                            "Workflow Console"
                        </h1>
                    </div>
                    <span
                        class="rounded-control border border-border px-2 py-1 font-mono text-[length:var(--type-code)] text-text-secondary"
                    >
                        "In-memory"
                    </span>
                </header>
                <main
                    class="grid w-full min-w-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(var(--rail-min),var(--rail-max))_minmax(0,1fr)] lg:p-6"
                >
                    workflow_rail(selected_workflow_id: selected_workflow_id)
                    <div class="min-w-0">
                        <p
                            id="request-message"
                            class="mb-4 border-l-[var(--error-border)] border-status-error bg-surface-elevated p-3"
                            data-show="$requestMessage !== ''"
                            data-text="$requestMessage"
                            role="alert"
                        ></p>
                        console_content(
                            runs: runs,
                            selected: selected_run.clone(),
                            history_filters_active: filters.is_active()
                        )
                    </div>
                </main>
            </body>
        </html>
    }
}

async fn not_found_document(cx: &Cx) -> Result {
    let __cx = cx;
    view! {
        (StatusCode::NOT_FOUND)
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta
                    http-equiv="refresh"
                    content=(format!("{NOT_FOUND_REDIRECT_DELAY_SECONDS}; url=/"))
                >
                <link rel="stylesheet" href=(topcoat::tailwind::stylesheet!())>
                <title>"Page not found · Workflow Console"</title>
            </head>
            <body class="grid min-h-screen place-items-center bg-canvas p-4 text-text-primary">
                <main
                    class="w-full max-w-xl rounded-panel border border-border bg-surface p-6 shadow-panel"
                    aria-labelledby="not-found-title"
                >
                    <p class="text-xs font-semibold uppercase tracking-label text-status-error">
                        "404"
                    </p>
                    <h1 id="not-found-title" class="mt-2 text-3xl font-semibold tracking-title">
                        "Page not found"
                    </h1>
                    <p class="mt-4 text-text-secondary">
                        "This route is not part of the local workflow console. Redirecting to the default workflow."
                    </p>
                    <a
                        class="mt-6 inline-flex min-h-[var(--control-min)] items-center rounded-control border border-accent-hover bg-accent px-4 font-semibold text-text-primary shadow-inset"
                        href="/"
                    >
                        "Return now"
                    </a>
                </main>
            </body>
        </html>
    }
}

#[component]
async fn workflow_rail(selected_workflow_id: &str) -> Result {
    let schedules = workflow_schedules();
    view! {
        <aside
            class="min-w-0 self-start rounded-panel border border-border bg-surface p-4 shadow-panel lg:sticky lg:top-6"
            aria-labelledby="workflows-title"
        >
            <h2 id="workflows-title" class="text-xl font-semibold">"Workflows"</h2>
            <div
                class="mt-4 grid gap-3"
                role="group"
                aria-label="Code-defined workflows"
            >
                for definition in workflow_definitions() {
                    <a
                        href=(workflow_url(definition.workflow_id, None))
                        class="grid w-full gap-2 rounded-control border border-border bg-surface-elevated p-4 text-left text-text-primary shadow-inset transition-[filter] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 aria-[current=page]:border-focus"
                        data-attr:aria-current=(format!(
                            "$selectedWorkflowId === '{}' ? 'page' : 'false'",
                            definition.workflow_id
                        ))
                    >
                        <span
                            class="text-xs font-semibold uppercase tracking-label text-text-muted"
                        >
                            "Code-defined"
                        </span>
                        <strong>(definition.name)</strong>
                        <span class="text-sm text-text-muted">
                            (definition.description)
                        </span>
                        <code class="font-mono text-[length:var(--type-code)]">
                            (definition.workflow_id)
                        </code>
                        for schedule in schedules
                            .iter()
                            .filter(|schedule| {
                                schedule.workflow_id == definition.workflow_id
                            }) {
                            <span class="grid gap-1 border-t border-border pt-3">
                                <span
                                    class="text-xs font-semibold uppercase tracking-label text-text-muted"
                                >
                                    "Cron schedule"
                                </span>
                                <code
                                    class="break-anywhere font-mono text-[length:var(--type-code)] text-status-healthy"
                                >
                                    (schedule.cron_expression)
                                </code>
                                <span class="text-sm text-text-muted">
                                    (schedule.input_summary)
                                </span>
                            </span>
                        }
                    </a>
                }
            </div>
            for definition in workflow_definitions()
                .iter()
                .filter(|definition| definition.workflow_id == selected_workflow_id) {
                workflow_input_form(
                    workflow_id: definition.workflow_id,
                    active: true
                )
            }
        </aside>
    }
}

#[allow(
    clippy::redundant_pub_crate,
    reason = "The route sibling renders this otherwise private page fragment."
)]
pub(crate) async fn render_history(
    service: &WorkflowService,
    filters: &HistoryFilters,
) -> Result<String> {
    let mut runs = service.list_runs().await;
    runs.reverse();
    runs.retain(|run| filters.matches(run));
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! {
        run_history(runs: runs, filters_active: filters.is_active())
    }?;
    Ok(rendered.render(&cx))
}

#[allow(
    clippy::redundant_pub_crate,
    reason = "The route sibling renders this otherwise private page fragment."
)]
pub(crate) async fn render_selected_host(
    service: &WorkflowService,
    run_id: &str,
) -> Result<String> {
    let run = find_run(service, run_id).await;
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { selected_inspector_host(run: run) }?;
    Ok(rendered.render(&cx))
}

#[allow(
    clippy::redundant_pub_crate,
    reason = "The route sibling renders this otherwise private page fragment."
)]
pub(crate) async fn render_recovery_host(service: &WorkflowService) -> Result<String> {
    let mut runs = service.list_runs().await;
    runs.reverse();
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { recovery_inspector_host(runs: runs) }?;
    Ok(rendered.render(&cx))
}

#[allow(
    clippy::redundant_pub_crate,
    reason = "The route sibling renders this otherwise private page fragment."
)]
pub(crate) async fn render_run_inspector(
    service: &WorkflowService,
    run_id: &str,
) -> Result<Option<String>> {
    let Some(run) = find_run(service, run_id).await else {
        return Ok(None);
    };
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_inspector(run: run) }?;
    Ok(Some(rendered.render(&cx)))
}

async fn find_run(service: &WorkflowService, run_id: &str) -> Option<RunSnapshot> {
    service
        .list_runs()
        .await
        .into_iter()
        .find(|run| run.run_id.as_str() == run_id)
}

fn initial_signals(
    selected_workflow_id: &str,
    selected_run: Option<&RunSnapshot>,
    filters: &HistoryFilters,
) -> InitialSignals {
    let trace_id = selected_run
        .and_then(|run| {
            run.current_node
                .clone()
                .or_else(|| run.steps.last().map(|step| step.node_id.clone()))
        })
        .unwrap_or_default();
    InitialSignals {
        selected_workflow_id: selected_workflow_id.to_owned(),
        selected_run_id: selected_run.map_or_else(String::new, |run| run.run_id.to_string()),
        selected_trace_kind: "node",
        selected_trace_id: trace_id,
        history: filters.values(),
        input: workflow_default_input(selected_workflow_id),
        request_message: "",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use workflow_console_experiment::{RunTrigger, WorkflowService, workflow_id};

    use crate::history_filter::{HistoryFilterValues, HistoryFilters};

    use super::routes::latest_run_url;
    use super::{
        initial_signals, render_history, render_recovery_host, workflow_rail, workflow_url,
    };

    #[test]
    fn workflow_url_nests_the_selected_run_under_its_workflow() {
        assert_eq!(
            workflow_url("review-pipeline", Some("run-123")),
            "/workflows/review-pipeline/runs/run-123"
        );
    }

    #[tokio::test]
    async fn latest_run_url_uses_the_newest_run_for_the_selected_workflow() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        service
            .start(
                "review-pipeline",
                json!({ "subject": "older", "reviewer": "qa" }),
                RunTrigger::Manual,
            )
            .await
            .expect("older review run should start");
        service
            .start(
                workflow_id(),
                json!({ "label": "unrelated", "step_delay_ms": 100 }),
                RunTrigger::Manual,
            )
            .await
            .expect("unrelated demo run should start");
        let newest = service
            .start(
                "review-pipeline",
                json!({ "subject": "newest", "reviewer": "qa" }),
                RunTrigger::Manual,
            )
            .await
            .expect("newest review run should start");

        assert_eq!(
            latest_run_url(&service.list_runs().await, "review-pipeline"),
            Some(workflow_url(
                "review-pipeline",
                Some(newest.run_id.as_str())
            ))
        );
    }

    #[tokio::test]
    async fn run_history_exposes_reactive_filter_controls_and_rows() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        let demo = service
            .start(
                workflow_id(),
                json!({ "label": "filterable", "step_delay_ms": 100 }),
                RunTrigger::Manual,
            )
            .await
            .expect("demo workflow should start");
        let review = service
            .start(
                "review-pipeline",
                json!({ "subject": "filterable", "reviewer": "qa" }),
                RunTrigger::Manual,
            )
            .await
            .expect("review workflow should start");
        let filters = HistoryFilters::from_values(&HistoryFilterValues {
            workflow: "review-pipeline".to_owned(),
            trigger: "all".to_owned(),
            status: "all".to_owned(),
        });

        let html = render_history(&service, &filters)
            .await
            .expect("history fragment should render");

        assert!(html.contains("data-bind=\"historyWorkflowFilter\""));
        assert!(html.contains("data-bind=\"historyTriggerFilter\""));
        assert!(html.contains("data-bind=\"historyStatusFilter\""));
        assert_eq!(html.matches("@get('/events')").count(), 4);
        assert!(!html.contains("data-show"));
        assert!(!html.contains(&demo.run_id.to_string()));
        assert!(html.contains(&format!(
            "href=\"/workflows/review-pipeline/runs/{}\"",
            review.run_id
        )));
    }

    #[tokio::test]
    async fn initial_signals_restore_the_workflow_and_run_from_the_url() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        let run = service
            .start(
                "review-pipeline",
                json!({ "subject": "restore", "reviewer": "Lin" }),
                RunTrigger::Manual,
            )
            .await
            .expect("review workflow should start");

        let filters = HistoryFilters::from_values(&HistoryFilterValues {
            workflow: "review-pipeline".to_owned(),
            trigger: "manual".to_owned(),
            status: "running".to_owned(),
        });
        let signals = initial_signals("review-pipeline", Some(&run), &filters);

        assert_eq!(signals.selected_workflow_id, "review-pipeline");
        assert_eq!(signals.selected_run_id, run.run_id.to_string());
        assert_eq!(signals.history.workflow, "review-pipeline");
        assert_eq!(signals.history.trigger, "manual");
        assert_eq!(signals.history.status, "running");
    }

    #[tokio::test]
    async fn workflow_rail_renders_only_the_selected_workflows_form() {
        let cx = topcoat::context::CxTestBuilder::new().build();
        let __cx = &cx;
        let rendered = topcoat::view::view! {
            workflow_rail(selected_workflow_id: "review-pipeline")
        }
        .expect("workflow rail should render")
        .render(&cx);

        assert_eq!(rendered.matches("data-on:submit").count(), 1);
    }

    #[tokio::test]
    async fn recovery_host_contains_every_run_for_signal_owned_selection() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        let demo = service
            .start(
                workflow_id(),
                json!({ "label": "recovery", "step_delay_ms": 100 }),
                RunTrigger::Manual,
            )
            .await
            .expect("demo workflow should start");
        let review = service
            .start(
                "review-pipeline",
                json!({ "subject": "recovery", "reviewer": "qa" }),
                RunTrigger::Manual,
            )
            .await
            .expect("review workflow should start");

        let html = render_recovery_host(&service)
            .await
            .expect("recovery fragment should render");

        assert!(html.contains(&format!("run-{}-inspector", demo.run_id)));
        assert!(html.contains(&format!("run-{}-inspector", review.run_id)));
        assert!(html.contains("$selectedRunId ==="));
    }
}
