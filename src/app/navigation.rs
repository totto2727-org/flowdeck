use workflow_console_experiment::RunSnapshot;

use crate::features::run_history::HistoryFilters;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RunTarget<'tail> {
    MissingRunlessSlash,
    Runless,
    ExactRun(&'tail str),
}

pub(crate) fn workflow_url(workflow_id: &str, run_id: Option<&str>) -> String {
    run_id.map_or_else(
        || format!("/workflows/{workflow_id}/runs/"),
        |run_id| format!("/workflows/{workflow_id}/runs/{run_id}"),
    )
}

pub(super) fn navigation_url(path: &str, filters: &HistoryFilters) -> String {
    format!("{path}{}", filters.query_suffix())
}

pub(super) fn canonical_filter_redirect(
    path: &str,
    current_query: Option<&str>,
    filters: &HistoryFilters,
) -> Option<String> {
    let suffix = filters.query_suffix();
    let canonical_query = suffix.strip_prefix('?');
    (current_query != canonical_query).then(|| format!("{path}{suffix}"))
}

pub(super) fn parse_workflow_tail(tail: &str) -> Option<RunTarget<'_>> {
    match tail.strip_prefix("runs") {
        Some("") => Some(RunTarget::MissingRunlessSlash),
        Some("/") => Some(RunTarget::Runless),
        Some(run_id) => run_id
            .strip_prefix('/')
            .filter(|run_id| !run_id.is_empty() && !run_id.contains('/'))
            .map(RunTarget::ExactRun),
        None => None,
    }
}

pub(super) fn latest_run_url(runs: &[RunSnapshot], workflow_id: &str) -> Option<String> {
    runs.iter()
        .filter(|run| run.workflow_id == workflow_id)
        .max_by(|left, right| left.started_at.cmp(&right.started_at))
        .map(|run| workflow_url(workflow_id, Some(run.run_id.as_str())))
}
