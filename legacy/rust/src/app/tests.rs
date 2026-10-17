use flowdeck::{RunTrigger, WorkflowService};
use serde_json::json;

use super::{
    navigation::{
        RunTarget, canonical_filter_redirect, latest_run_url, navigation_url, parse_workflow_tail,
        workflow_url,
    },
    page::initial_signals,
};
use crate::features::{
    run_history::{HistoryFilterQuery, HistoryFilterValues, HistoryFilters},
    workflow_launcher::workflow_rail,
};

#[tokio::test]
async fn initial_signals_restore_the_workflow_and_run_from_the_url() {
    let service = WorkflowService::new().expect("code-defined workflows should build");
    let run = service
        .start(
            "review-pipeline",
            json!({ "subject": "restore", "reviewer": "Lin" }),
            RunTrigger::Manual,
        )
        .await
        .expect("review workflow should start");
    let filters = HistoryFilters::from_values(&HistoryFilterValues {
        workflow: "review-pipeline".to_owned(),
        trigger: "manual".to_owned(),
        status: "running".to_owned(),
    });

    let signals = initial_signals("review-pipeline", Some(&run), &filters);

    assert_eq!(signals.selected_workflow_id, "review-pipeline");
    assert_eq!(signals.selected_run_id, run.run_id.to_string());
    assert_eq!(signals.history.workflow, "review-pipeline");
    assert_eq!(signals.history.trigger, "manual");
    assert_eq!(signals.history.status, "running");
}

#[tokio::test]
async fn workflow_rail_keeps_filters_and_renders_only_the_selected_form() {
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let filters = HistoryFilters::from_query(&HistoryFilterQuery {
        history_workflow: Some("review-pipeline".to_owned()),
        history_trigger: Some("all".to_owned()),
        history_status: Some("completed".to_owned()),
    });
    let rendered = topcoat::view::view! {
        workflow_rail(selected_workflow_id: "review-pipeline", filters: &filters)
    }
    .expect("workflow rail should render")
    .render(&cx);

    assert_eq!(rendered.matches("data-on:submit").count(), 1);
    assert!(rendered.contains(
        "href=\"/workflows/demo-workflow/runs/?history_workflow=review-pipeline&amp;history_status=completed\""
    ));
}

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
        navigation_url("/workflows/review-pipeline/runs/", &filters),
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
        canonical_filter_redirect(
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
        canonical_filter_redirect(
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
        parse_workflow_tail("runs"),
        Some(RunTarget::MissingRunlessSlash)
    );
}

#[test]
fn workflow_tail_with_a_trailing_slash_selects_the_runless_graph() {
    assert_eq!(parse_workflow_tail("runs/"), Some(RunTarget::Runless));
}

#[test]
fn workflow_tail_with_one_run_id_selects_that_exact_run() {
    assert_eq!(
        parse_workflow_tail("runs/run-123"),
        Some(RunTarget::ExactRun("run-123"))
    );
}

#[test]
fn workflow_tail_with_an_extra_segment_is_rejected() {
    assert_eq!(parse_workflow_tail("runs/run-123/extra"), None);
}
