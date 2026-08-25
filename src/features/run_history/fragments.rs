use flowdeck::RunSnapshot;
use topcoat::{Result, view::view};

use super::{
    component::{run_history_empty, run_history_row},
    filter::HistoryFilters,
};

pub(super) async fn render_history_row(
    run: &RunSnapshot,
    filters: &HistoryFilters,
) -> Result<String> {
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_history_row(run: run.clone(), filters: filters.clone()) }?;
    Ok(rendered.render(&cx))
}

pub(super) async fn render_history_empty(filters: &HistoryFilters) -> Result<String> {
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_history_empty(filters_active: filters.is_active()) }?;
    Ok(rendered.render(&cx))
}
