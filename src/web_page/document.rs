use serde::Serialize;
use serde_json::Value;
use topcoat::{Result, context::Cx, router::StatusCode, view::view};
use workflow_console_experiment::{HistoryView, RunSnapshot, workflow_default_input};

use super::{
    DATASTAR_JS, NOT_FOUND_REDIRECT_DELAY_SECONDS, console::console_content, routes::workflow_url,
};
use crate::features::{
    run_history::{HistoryFilterValues, HistoryFilters, HistoryPanelState},
    workflow_launcher::workflow_rail,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InitialSignals {
    pub(super) selected_workflow_id: String,
    pub(super) selected_run_id: String,
    selected_trace_kind: &'static str,
    selected_trace_id: String,
    #[serde(flatten)]
    pub(super) history: HistoryFilterValues,
    input: Value,
    request_message: &'static str,
}

pub(super) async fn render_console_page(
    cx: &Cx,
    selected_workflow_id: &str,
    selected_run: Option<RunSnapshot>,
    history: HistoryView,
    filters: &HistoryFilters,
) -> Result {
    let __cx = cx;
    let signals_json = serde_json::to_string(&initial_signals(
        selected_workflow_id,
        selected_run.as_ref(),
        filters,
    ))?;
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
            <body data-signals=(signals_json)>
                <header class="flex items-start justify-between gap-4 border-b border-border bg-surface px-4 py-4 lg:items-center lg:px-8">
                    <div>
                        <p class="text-xs font-semibold uppercase tracking-label text-text-muted">"Local operations"</p>
                        <h1 class="text-3xl font-semibold tracking-title">"Workflow Console"</h1>
                    </div>
                    <span class="rounded-control border border-border px-2 py-1 font-mono text-[length:var(--type-code)] text-text-secondary">"In-memory"</span>
                </header>
                <main class="grid w-full min-w-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(var(--rail-min),var(--rail-max))_minmax(0,1fr)] lg:p-6">
                    workflow_rail(selected_workflow_id: selected_workflow_id, filters: filters)
                    <div class="min-w-0">
                        <p id="request-message" class="mb-4 border-l-[var(--error-border)] border-status-error bg-surface-elevated p-3" data-show="$requestMessage !== ''" data-text="$requestMessage" role="alert"></p>
                        console_content(
                            selected_workflow_id: selected_workflow_id,
                            selected: selected_run.clone(),
                            history: HistoryPanelState::new(
                                history,
                                filters.clone(),
                                workflow_url(
                                    selected_workflow_id,
                                    selected_run.as_ref().map(|run| run.run_id.as_str()),
                                ),
                            )
                        )
                    </div>
                </main>
            </body>
        </html>
    }
}

pub(super) async fn not_found_document(cx: &Cx) -> Result {
    let __cx = cx;
    view! {
        (StatusCode::NOT_FOUND)
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta http-equiv="refresh" content=(format!("{NOT_FOUND_REDIRECT_DELAY_SECONDS}; url=/"))>
                <link rel="stylesheet" href=(topcoat::tailwind::stylesheet!())>
                <title>"Page not found · Workflow Console"</title>
            </head>
            <body class="grid min-h-screen place-items-center bg-canvas p-4 text-text-primary">
                <main class="w-full max-w-xl rounded-panel border border-border bg-surface p-6 shadow-panel" aria-labelledby="not-found-title">
                    <p class="text-xs font-semibold uppercase tracking-label text-status-error">"404"</p>
                    <h1 id="not-found-title" class="mt-2 text-3xl font-semibold tracking-title">"Page not found"</h1>
                    <p class="mt-4 text-text-secondary">"This route is not part of the local workflow console. Redirecting to the default workflow."</p>
                    <a class="mt-6 inline-flex min-h-[var(--control-min)] items-center rounded-control border border-accent-hover bg-accent px-4 font-semibold text-text-primary shadow-inset" href="/">"Return now"</a>
                </main>
            </body>
        </html>
    }
}

pub(super) fn initial_signals(
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
