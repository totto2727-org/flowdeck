use flowdeck::HistoryView;
use topcoat::{Result, view::view};

use super::{
    component::{filtered_history_runs, run_history_empty, run_history_row},
    filter::HistoryFilters,
};

pub(super) async fn render_history_body(
    history: HistoryView,
    filters: &HistoryFilters,
) -> Result<String> {
    let runs = filtered_history_runs(history, filters);
    let filters_active = filters.is_active();
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! {
        if runs.is_empty() {
            run_history_empty(filters_active: filters_active)
        }
        for run in runs {
            run_history_row(run: run, filters: filters.clone())
        }
    }?;
    Ok(rendered.render(&cx))
}
