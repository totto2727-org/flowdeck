mod console;
mod presentation;
mod topology;
mod trace;

use serde::Serialize;
use serde_json::Value;
use topcoat::{
    Result,
    asset::{Asset, asset},
    context::{Cx, app_context},
    router::page,
    view::{component, view},
};
use workflow_console_experiment::{
    RunSnapshot, WorkflowService, workflow_default_input, workflow_definitions, workflow_id,
    workflow_input_form, workflow_schedules,
};

use self::console::{
    console_content, recovery_inspector_host, run_history, run_inspector, selected_inspector_host,
};

const DATASTAR_JS: Asset =
    asset!("https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.2/bundles/datastar.js");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitialSignals {
    selected_workflow_id: String,
    selected_run_id: String,
    selected_trace_kind: &'static str,
    selected_trace_id: String,
    history_workflow_filter: &'static str,
    history_trigger_filter: &'static str,
    history_status_filter: &'static str,
    input: Value,
    request_message: &'static str,
}

#[page("/")]
async fn home(cx: &Cx) -> Result {
    let service = app_context::<WorkflowService>(cx);
    let mut runs = service.list_runs().await;
    runs.reverse();
    let signals = initial_signals(&runs);
    let signals_json = serde_json::to_string(&signals)?;
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="description" content="Inspect and run local code-defined workflows">
                <link rel="stylesheet" href=(topcoat::tailwind::stylesheet!())>
                <script type="module" src=(DATASTAR_JS)></script>
                <title>"Workflow Console"</title>
            </head>
            <body data-signals=(signals_json) data-init="@get('/events')">
                <header class="flex items-start justify-between gap-4 border-b border-border bg-surface px-4 py-4 lg:items-center lg:px-8">
                    <div><p class="text-xs font-semibold uppercase tracking-label text-text-muted">"Local operations"</p><h1 class="text-3xl font-semibold tracking-title">"Workflow Console"</h1></div>
                    <span class="rounded-control border border-border px-2 py-1 font-mono text-[length:var(--type-code)] text-text-secondary">"In-memory"</span>
                </header>
                <main class="grid w-full min-w-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(var(--rail-min),var(--rail-max))_minmax(0,1fr)] lg:p-6">
                    workflow_rail()
                    <div class="min-w-0">
                        <p id="request-message" class="mb-4 border-l-[var(--error-border)] border-status-error bg-surface-elevated p-3" data-show="$requestMessage !== ''" data-text="$requestMessage" role="alert"></p>
                        console_content(runs: runs)
                    </div>
                </main>
            </body>
        </html>
    }
}

#[component]
async fn workflow_rail() -> Result {
    let schedules = workflow_schedules();
    view! {
        <aside class="min-w-0 self-start rounded-panel border border-border bg-surface p-4 shadow-panel lg:sticky lg:top-6" aria-labelledby="workflows-title">
            <h2 id="workflows-title" class="text-xl font-semibold">"Workflows"</h2>
            <div class="mt-4 grid gap-3" role="group" aria-label="Code-defined workflows">
                for definition in workflow_definitions() {
                    <button type="button" class="grid w-full gap-2 rounded-control border border-border bg-surface-elevated p-4 text-left text-text-primary shadow-inset transition-[filter] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 aria-[pressed=true]:border-focus" data-attr:aria-pressed=(format!("$selectedWorkflowId === '{}'", definition.workflow_id)) data-on:click=(selection_expression(definition.workflow_id)?)>
                        <span class="text-xs font-semibold uppercase tracking-label text-text-muted">"Code-defined"</span>
                        <strong>(definition.name)</strong><span class="text-sm text-text-muted">(definition.description)</span><code class="font-mono text-[length:var(--type-code)]">(definition.workflow_id)</code>
                        for schedule in schedules.iter().filter(|schedule| schedule.workflow_id == definition.workflow_id) {
                            <span class="grid gap-1 border-t border-border pt-3"><span class="text-xs font-semibold uppercase tracking-label text-text-muted">"Cron schedule"</span><code class="break-anywhere font-mono text-[length:var(--type-code)] text-status-healthy">(schedule.cron_expression)</code><span class="text-sm text-text-muted">(schedule.input_summary)</span></span>
                        }
                    </button>
                }
            </div>
            for definition in workflow_definitions() {
                workflow_input_form(workflow_id: definition.workflow_id, active: definition.workflow_id == workflow_id())
            }
        </aside>
    }
}

#[allow(
    clippy::redundant_pub_crate,
    reason = "The route sibling renders this otherwise private page fragment."
)]
pub(crate) async fn render_history(service: &WorkflowService) -> Result<String> {
    let mut runs = service.list_runs().await;
    runs.reverse();
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_history(runs: runs) }?;
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

fn initial_signals(runs: &[RunSnapshot]) -> InitialSignals {
    let selected = runs.first();
    let workflow_id =
        selected.map_or_else(|| workflow_id().to_owned(), |run| run.workflow_id.clone());
    let trace_id = selected
        .and_then(|run| {
            run.current_node
                .clone()
                .or_else(|| run.steps.last().map(|step| step.node_id.clone()))
        })
        .unwrap_or_default();
    InitialSignals {
        selected_workflow_id: workflow_id.clone(),
        selected_run_id: selected.map_or_else(String::new, |run| run.run_id.to_string()),
        selected_trace_kind: "node",
        selected_trace_id: trace_id,
        history_workflow_filter: "all",
        history_trigger_filter: "all",
        history_status_filter: "all",
        input: workflow_default_input(&workflow_id),
        request_message: "",
    }
}

fn selection_expression(workflow_id: &str) -> Result<String> {
    let input = serde_json::to_string(&workflow_default_input(workflow_id))?;
    Ok(format!(
        "$selectedWorkflowId = '{workflow_id}'; $selectedRunId = ''; $selectedTraceKind = 'node'; $selectedTraceId = ''; $input = {input}; $requestMessage = ''; @get('/actions/select-run')"
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use workflow_console_experiment::{RunTrigger, WorkflowService, workflow_id};

    use super::{render_history, render_recovery_host, selection_expression};

    #[tokio::test]
    async fn run_history_exposes_reactive_filter_controls_and_rows() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        service
            .start(
                workflow_id(),
                json!({ "label": "filterable", "step_delay_ms": 100 }),
                RunTrigger::Manual,
            )
            .await
            .expect("demo workflow should start");

        let html = render_history(&service)
            .await
            .expect("history fragment should render");

        assert!(html.contains("data-bind=\"historyWorkflowFilter\""));
        assert!(html.contains("data-bind=\"historyTriggerFilter\""));
        assert!(html.contains("data-bind=\"historyStatusFilter\""));
        assert!(html.contains("$historyWorkflowFilter === 'demo-workflow'"));
        assert!(html.contains("$historyTriggerFilter === 'manual'"));
        assert!(html.contains("$historyStatusFilter === 'running'"));
    }

    #[test]
    fn workflow_selection_requests_idle_inspector_after_run_is_cleared() {
        // Given a workflow card selection expression.
        let expression = selection_expression("review-pipeline")
            .expect("the code-defined default input should serialize");

        // When Datastar evaluates the expression, it must clear the retained run first.
        let clear_run = expression
            .find("$selectedRunId = ''")
            .expect("workflow selection should clear the retained run");

        // Then the server-rendered inspector must be refreshed using the cleared signal.
        let refresh_inspector = expression
            .find("@get('/actions/select-run')")
            .expect("workflow selection should refresh the idle inspector");
        assert!(clear_run < refresh_inspector);
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
