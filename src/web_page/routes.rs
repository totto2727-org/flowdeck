use topcoat::{
    Result,
    context::{Cx, app_context},
    router::{
        error::{not_found as not_found_error, redirect},
        page, parse_query_params, path_param, uri,
    },
};
use workflow_console_experiment::{
    HistoryView, RunSnapshot, WorkflowService, workflow_definitions, workflow_id,
};

use super::document::render_console_page;
use crate::features::run_history::{HistoryFilterQuery, HistoryFilters};

#[path_param]
struct WorkflowPath(str);

#[path_param]
struct WorkflowTail(str);

#[derive(Debug, PartialEq, Eq)]
enum RunTarget<'tail> {
    MissingRunlessSlash,
    Runless,
    ExactRun(&'tail str),
}

#[page("/")]
async fn root_redirect(cx: &Cx) -> Result {
    let default_workflow_id = workflow_id();
    let service = app_context::<WorkflowService>(cx);
    let history = service.history_view().await;
    let filters = history_filters(cx)?;
    let location = latest_run_url(&history.runs, default_workflow_id)
        .unwrap_or_else(|| workflow_url(default_workflow_id, None));
    Err(redirect(&navigation_url(&location, &filters)).into())
}

#[page("/workflows/{workflow_path}")]
async fn workflow_page(cx: &Cx) -> Result {
    let selected_workflow_id = workflow_id_from_path(cx)?;
    let service = app_context::<WorkflowService>(cx);
    let history = service.history_view().await;
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
    let history = service.history_view().await;
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

fn parse_workflow_tail(tail: &str) -> Option<RunTarget<'_>> {
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
        || format!("/workflows/{workflow_id}/runs/"),
        |run_id| format!("/workflows/{workflow_id}/runs/{run_id}"),
    )
}

fn navigation_url(path: &str, filters: &HistoryFilters) -> String {
    format!("{path}{}", filters.query_suffix())
}

fn canonical_filter_redirect(
    path: &str,
    current_query: Option<&str>,
    filters: &HistoryFilters,
) -> Option<String> {
    let suffix = filters.query_suffix();
    let canonical_query = suffix.strip_prefix('?');
    (current_query != canonical_query).then(|| format!("{path}{suffix}"))
}

pub(super) fn latest_run_url(runs: &[RunSnapshot], workflow_id: &str) -> Option<String> {
    runs.iter()
        .filter(|run| run.workflow_id == workflow_id)
        .max_by(|left, right| left.started_at.cmp(&right.started_at))
        .map(|run| workflow_url(workflow_id, Some(run.run_id.as_str())))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use workflow_console_experiment::{RunTrigger, WorkflowService};

    use super::{latest_run_url, workflow_url};
    use crate::features::run_history::{HistoryFilterQuery, HistoryFilters};

    #[test]
    fn workflow_url_without_a_run_uses_the_canonical_runless_path() {
        assert_eq!(
            workflow_url("review-pipeline", None),
            "/workflows/review-pipeline/runs/"
        );
    }

    #[tokio::test]
    async fn latest_run_url_selects_the_newest_run_for_its_workflow() {
        let service = WorkflowService::new().expect("code-defined workflows should build");
        service
            .start(
                "review-pipeline",
                json!({ "subject": "older", "reviewer": "qa" }),
                RunTrigger::Manual,
            )
            .await
            .expect("older review run should start");
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

    #[test]
    fn navigation_url_keeps_the_normalized_history_filter_suffix() {
        let filters = HistoryFilters::from_query(&HistoryFilterQuery {
            history_workflow: Some("review-pipeline".to_owned()),
            history_trigger: Some("unsupported".to_owned()),
            history_status: Some("completed".to_owned()),
        });

        assert_eq!(
            super::navigation_url("/workflows/review-pipeline/runs/", &filters),
            "/workflows/review-pipeline/runs/?history_workflow=review-pipeline&history_status=completed"
        );
    }

    #[test]
    fn rendered_page_redirects_noncanonical_filter_query_to_the_exact_run_path() {
        let filters = HistoryFilters::from_query(&HistoryFilterQuery {
            history_workflow: Some("review-pipeline".to_owned()),
            history_trigger: Some("invalid".to_owned()),
            history_status: Some("completed".to_owned()),
        });

        assert_eq!(
            super::canonical_filter_redirect(
                "/workflows/review-pipeline/runs/run-123",
                Some("history_status=completed&history_trigger=invalid&history_workflow=review-pipeline"),
                &filters,
            ),
            Some("/workflows/review-pipeline/runs/run-123?history_workflow=review-pipeline&history_status=completed".to_owned())
        );
    }

    #[test]
    fn rendered_runless_page_redirects_explicit_all_filters_to_the_bare_path() {
        let filters = HistoryFilters::from_query(&HistoryFilterQuery {
            history_workflow: Some("all".to_owned()),
            history_trigger: Some("all".to_owned()),
            history_status: Some("all".to_owned()),
        });

        assert_eq!(
            super::canonical_filter_redirect(
                "/workflows/review-pipeline/runs/",
                Some("history_workflow=all&history_trigger=all&history_status=all"),
                &filters,
            ),
            Some("/workflows/review-pipeline/runs/".to_owned())
        );
    }

    #[test]
    fn workflow_tail_without_a_trailing_slash_requests_canonicalization() {
        assert_eq!(
            super::parse_workflow_tail("runs"),
            Some(super::RunTarget::MissingRunlessSlash)
        );
    }

    #[test]
    fn workflow_tail_with_a_trailing_slash_selects_the_runless_graph() {
        assert_eq!(
            super::parse_workflow_tail("runs/"),
            Some(super::RunTarget::Runless)
        );
    }

    #[test]
    fn workflow_tail_with_one_run_id_selects_that_exact_run() {
        assert_eq!(
            super::parse_workflow_tail("runs/run-123"),
            Some(super::RunTarget::ExactRun("run-123"))
        );
    }

    #[test]
    fn workflow_tail_with_an_extra_segment_is_rejected() {
        assert_eq!(super::parse_workflow_tail("runs/run-123/extra"), None);
    }
}
