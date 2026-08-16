use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use topcoat::{
    Result,
    context::{Cx, app_context},
    datastar::{ExecuteScript, PatchElements, PatchSignals, Signals},
    router::{
        content::sse::{Event, KeepAlive, Sse},
        route,
    },
};
use workflow_console_experiment::{RunTrigger, WorkflowEvent, WorkflowService};

use crate::history_filter::{HistoryFilterValues, HistoryFilters};
use crate::web_page::{
    render_history, render_recovery_host, render_run_inspector, render_selected_host, workflow_url,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSignals {
    selected_workflow_id: String,
    input: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionSignals {
    selected_run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsSignals {
    selected_run_id: String,
    #[serde(flatten)]
    history: HistoryFilterValues,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartPatch {
    selected_workflow_id: String,
    selected_run_id: String,
    selected_trace_kind: &'static str,
    selected_trace_id: String,
    request_message: String,
}

#[route(POST "/actions/runs")]
async fn start_run(
    cx: &Cx,
    Signals(signals): Signals<StartSignals>,
) -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let service = app_context::<WorkflowService>(cx);
    let workflow_id = signals.selected_workflow_id;
    let result = service
        .start(&workflow_id, signals.input, RunTrigger::Manual)
        .await;
    let (signal_patch, host, run_url) = match result {
        Ok(run) => {
            let run_id = run.run_id.to_string();
            let run_url = workflow_url(&run.workflow_id, Some(&run_id));
            let patch = PatchSignals::json(&StartPatch {
                selected_workflow_id: run.workflow_id,
                selected_run_id: run_id.clone(),
                selected_trace_kind: "node",
                selected_trace_id: run.current_node.unwrap_or_default(),
                request_message: String::new(),
            })?;
            (
                patch,
                Some(render_selected_host(service, &run_id).await?),
                Some(run_url),
            )
        }
        Err(error) => (
            PatchSignals::json(&StartPatch {
                selected_workflow_id: workflow_id,
                selected_run_id: String::new(),
                selected_trace_kind: "node",
                selected_trace_id: String::new(),
                request_message: error.to_string(),
            })?,
            None,
            None,
        ),
    };
    let stream = async_stream::stream! {
        yield Ok(signal_patch.into());
        if let Some(host) = host { yield Ok(PatchElements::new(host).into()); }
        if let Some(run_url) = run_url {
            let run_url = serde_json::to_string(&run_url)?;
            yield Ok(ExecuteScript::new(format!(
                "window.history.replaceState(null, '', {run_url})"
            )).into());
        }
    };
    Ok(Sse::new(stream))
}

#[route(GET "/actions/select-run")]
async fn select_run(cx: &Cx, Signals(signals): Signals<SelectionSignals>) -> Result<PatchElements> {
    let service = app_context::<WorkflowService>(cx);
    Ok(PatchElements::new(
        render_selected_host(service, &signals.selected_run_id).await?,
    ))
}

#[route(GET "/events")]
#[allow(
    clippy::collapsible_if,
    reason = "async-stream expands under an edition that cannot parse Rust 2024 let chains."
)]
async fn events(
    cx: &Cx,
    Signals(signals): Signals<EventsSignals>,
) -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let service = app_context::<WorkflowService>(cx).clone();
    let mut receiver = service.subscribe();
    let selected_run_id = signals.selected_run_id;
    let filters = HistoryFilters::from_values(&signals.history);
    filters.store_in_cookies(cx);
    let stream = async_stream::stream! {
        yield history_event(&service, &filters).await;
        yield selected_host_event(&service, &selected_run_id).await;
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    yield history_event(&service, &filters).await;
                    if let Some(run_id) = event_run_id(&event) {
                        if let Some(html) = render_run_inspector(&service, run_id).await? {
                            yield Ok(PatchElements::new(html).into());
                        }
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    yield history_event(&service, &filters).await;
                    yield recovery_host_event(&service).await;
                }
                Err(RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::new()))
}

async fn history_event(service: &WorkflowService, filters: &HistoryFilters) -> Result<Event> {
    Ok(PatchElements::new(render_history(service, filters).await?).into())
}

async fn selected_host_event(service: &WorkflowService, run_id: &str) -> Result<Event> {
    Ok(PatchElements::new(render_selected_host(service, run_id).await?).into())
}

async fn recovery_host_event(service: &WorkflowService) -> Result<Event> {
    Ok(PatchElements::new(render_recovery_host(service).await?).into())
}

fn event_run_id(event: &WorkflowEvent) -> Option<&str> {
    match event {
        WorkflowEvent::RunStarted { run_id, .. }
        | WorkflowEvent::NodeStarted { run_id, .. }
        | WorkflowEvent::NodeCompleted { run_id, .. }
        | WorkflowEvent::RunCompleted { run_id, .. }
        | WorkflowEvent::RunFailed { run_id, .. } => Some(run_id.as_str()),
        _ => None,
    }
}
