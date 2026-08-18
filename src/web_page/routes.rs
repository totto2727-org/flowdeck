use topcoat::{
    Result,
    context::{Cx, app_context},
    router::{
        error::{not_found as not_found_error, redirect},
        page, path_param,
    },
};
use workflow_console_experiment::{
    RunSnapshot, WorkflowService, workflow_definitions, workflow_id,
};

use super::render_console_page;
use crate::history_filter::HistoryFilters;

#[path_param]
struct WorkflowPath(str);

#[path_param]
struct RunPath(str);

#[page("/")]
async fn root_redirect(cx: &Cx) -> Result {
    let default_workflow_id = workflow_id();
    let service = app_context::<WorkflowService>(cx);
    let runs = service.list_runs().await;
    let location = latest_run_url(&runs, default_workflow_id)
        .unwrap_or_else(|| workflow_url(default_workflow_id, None));
    Err(redirect(&location).into())
}

#[page("/workflows/{workflow_path}")]
async fn workflow_page(cx: &Cx) -> Result {
    let selected_workflow_id = workflow_id_from_path(cx)?;
    let service = app_context::<WorkflowService>(cx);
    let runs = service.list_runs().await;
    if let Some(location) = latest_run_url(&runs, selected_workflow_id) {
        return Err(redirect(&location).into());
    }
    workflow_document(cx, None, runs).await
}

#[page("/workflows/{workflow_path}/runs/{run_path}")]
async fn workflow_run_page(cx: &Cx) -> Result {
    let selected_workflow_id = workflow_id_from_path(cx)?;
    let selected_run_id = path_param::<RunPath>(cx);
    let service = app_context::<WorkflowService>(cx);
    let runs = service.list_runs().await;
    let selected_run = runs
        .iter()
        .find(|run| {
            run.run_id.as_str() == selected_run_id && run.workflow_id == selected_workflow_id
        })
        .cloned();
    if selected_run.is_none() {
        return Err(not_found_error().into());
    }
    workflow_document(cx, selected_run, runs).await
}

async fn workflow_document(
    cx: &Cx,
    selected_run: Option<RunSnapshot>,
    mut runs: Vec<RunSnapshot>,
) -> Result {
    let selected_workflow_id = path_param::<WorkflowPath>(cx);
    let filters = HistoryFilters::from_cookies(cx);
    runs.reverse();
    runs.retain(|run| filters.matches(run));
    render_console_page(cx, selected_workflow_id, selected_run, runs, &filters).await
}

fn workflow_id_from_path(cx: &Cx) -> Result<&str> {
    let selected_workflow_id = path_param::<WorkflowPath>(cx);
    if workflow_definitions()
        .iter()
        .any(|definition| definition.workflow_id == selected_workflow_id)
    {
        Ok(selected_workflow_id)
    } else {
        Err(not_found_error().into())
    }
}

#[allow(
    clippy::redundant_pub_crate,
    reason = "The route action sibling uses this private navigation formatter."
)]
pub(crate) fn workflow_url(workflow_id: &str, run_id: Option<&str>) -> String {
    run_id.map_or_else(
        || format!("/workflows/{workflow_id}"),
        |run_id| format!("/workflows/{workflow_id}/runs/{run_id}"),
    )
}

pub(super) fn latest_run_url(runs: &[RunSnapshot], workflow_id: &str) -> Option<String> {
    runs.iter()
        .filter(|run| run.workflow_id == workflow_id)
        .max_by(|left, right| left.started_at.cmp(&right.started_at))
        .map(|run| workflow_url(workflow_id, Some(run.run_id.as_str())))
}
