#![allow(
    clippy::redundant_pub_crate,
    reason = "Sibling web modules consume these fragment render adapters through the page facade."
)]

use topcoat::{Result, view::view};
use workflow_console_experiment::{RunSnapshot, WorkflowService};

use super::{
    console::run_inspector,
    history::{run_history_empty, run_history_row},
};
use crate::history_filter::HistoryFilters;

pub(crate) async fn render_history_row(
    run: &RunSnapshot,
    filters: &HistoryFilters,
) -> Result<String> {
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_history_row(run: run.clone(), filters: filters.clone()) }?;
    Ok(rendered.render(&cx))
}

pub(crate) async fn render_history_empty(filters: &HistoryFilters) -> Result<String> {
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_history_empty(filters_active: filters.is_active()) }?;
    Ok(rendered.render(&cx))
}

pub(crate) async fn render_run_inspector(
    service: &WorkflowService,
    run_id: &str,
) -> Result<Option<String>> {
    let Some(run) = service
        .list_runs()
        .await
        .into_iter()
        .find(|run| run.run_id.as_str() == run_id)
    else {
        return Ok(None);
    };
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_inspector(run: run) }?;
    Ok(Some(rendered.render(&cx)))
}
