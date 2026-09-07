use flowdeck::{HistoryView, RunSnapshot, WorkflowService, workflow_definitions, workflow_id};
use topcoat::{
    Result,
    context::{Cx, app_context},
    router::{
        error::{not_found as not_found_error, redirect},
        page, parse_query_params, path_param, uri,
    },
};

use super::{
    navigation::{
        RunTarget, canonical_filter_redirect, latest_run_url, navigation_url, parse_workflow_tail,
        workflow_url,
    },
    page::render_console_page,
};
use crate::features::run_history::{HistoryFilterQuery, HistoryFilters};

#[path_param]
struct WorkflowPath(str);

#[path_param]
struct WorkflowTail(str);

#[page("/")]
async fn root_redirect(cx: &Cx) -> Result {
    let default_workflow_id = workflow_id();
    let service = app_context::<WorkflowService>(cx);
    let history = service.history_view().await?;
    let filters = history_filters(cx)?;
    let location = latest_run_url(&history.runs, default_workflow_id)
        .unwrap_or_else(|| workflow_url(default_workflow_id, None));
    Err(redirect(&navigation_url(&location, &filters)).into())
}

#[page("/workflows/{workflow_path}")]
async fn workflow_page(cx: &Cx) -> Result {
    let selected_workflow_id = workflow_id_from_path(cx)?;
    let service = app_context::<WorkflowService>(cx);
    let history = service.history_view().await?;
    let filters = history_filters(cx)?;
    let location = latest_run_url(&history.runs, selected_workflow_id)
        .unwrap_or_else(|| workflow_url(selected_workflow_id, None));
    Err(redirect(&navigation_url(&location, &filters)).into())
}

#[page("/workflows/{workflow_path}/{*workflow_tail}")]
async fn workflow_run_page(cx: &Cx) -> Result {
    let selected_workflow_id = workflow_id_from_path(cx)?;
    let filters = history_filters(cx)?;
    let target = parse_workflow_tail(path_param::<WorkflowTail>(cx)).ok_or_else(not_found_error)?;
    let service = app_context::<WorkflowService>(cx);
    let history = service.history_view().await?;
    match target {
        RunTarget::MissingRunlessSlash => Err(redirect(&navigation_url(
            &workflow_url(selected_workflow_id, None),
            &filters,
        ))
        .into()),
        RunTarget::Runless => {
            if let Some(location) = latest_run_url(&history.runs, selected_workflow_id) {
                return Err(redirect(&navigation_url(&location, &filters)).into());
            }
            workflow_document(cx, None, history, filters).await
        }
        RunTarget::ExactRun(selected_run_id) => {
            let selected_run = history
                .runs
                .iter()
                .find(|run| {
                    run.run_id.as_str() == selected_run_id
                        && run.workflow_id == selected_workflow_id
                })
                .cloned();
            if selected_run.is_none() {
                return Err(not_found_error().into());
            }
            workflow_document(cx, selected_run, history, filters).await
        }
    }
}

#[page("/{*missing_path}")]
async fn missing_page() -> Result {
    Err(not_found_error().into())
}

async fn workflow_document(
    cx: &Cx,
    selected_run: Option<RunSnapshot>,
    history: HistoryView,
    filters: HistoryFilters,
) -> Result {
    if let Some(location) = canonical_filter_redirect(uri(cx).path(), uri(cx).query(), &filters) {
        return Err(redirect(&location).into());
    }
    let selected_workflow_id = path_param::<WorkflowPath>(cx);
    render_console_page(cx, selected_workflow_id, selected_run, history, &filters).await
}

fn history_filters(cx: &Cx) -> Result<HistoryFilters> {
    let query = parse_query_params::<HistoryFilterQuery>(cx)?;
    Ok(HistoryFilters::from_query(&query))
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
