use serde_json::json;
use workflow_console_experiment::{RunTrigger, WorkflowService, workflow_id};

use super::{
    document::initial_signals,
    history::{HistoryPanelState, history_panel},
    rail::workflow_rail,
    routes::workflow_url,
};
use crate::history_filter::{HistoryFilterQuery, HistoryFilterValues, HistoryFilters};

#[tokio::test]
async fn run_history_renders_url_driven_filters_and_delta_ready_rows() {
    let service = WorkflowService::new().expect("code-defined workflows should build");
    let demo = service
        .start(
            workflow_id(),
            json!({ "label": "filterable", "step_delay_ms": 100 }),
            RunTrigger::Manual,
        )
        .await
        .expect("demo workflow should start");
    let review = service
        .start(
            "review-pipeline",
            json!({ "subject": "filterable", "reviewer": "qa" }),
            RunTrigger::Manual,
        )
        .await
        .expect("review workflow should start");
    let filters = HistoryFilters::from_values(&HistoryFilterValues {
        workflow: "review-pipeline".to_owned(),
        trigger: "all".to_owned(),
        status: "all".to_owned(),
    });

    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let html = topcoat::view::view! {
        history_panel(state: HistoryPanelState::new(
            service.history_view().await,
            filters,
            workflow_url("review-pipeline", None),
        ))
    }
    .expect("history fragment should render")
    .render(&cx);

    assert!(html.contains("<form method=\"get\""));
    assert!(html.contains("action=\"/workflows/review-pipeline/runs/\""));
    assert!(html.contains("name=\"history_workflow\""));
    assert!(html.contains("id=\"run-history-body\""));
    assert!(html.contains(&format!("id=\"run-history-{}\"", review.run_id)));
    assert!(html.contains("/events/history?after="));
    assert!(!html.contains("@get('/events')"));
    assert!(!html.contains(&demo.run_id.to_string()));
    assert!(html.contains(&format!(
        "href=\"/workflows/review-pipeline/runs/{}?history_workflow=review-pipeline\"",
        review.run_id
    )));
}

#[tokio::test]
async fn history_events_url_includes_the_ssr_revision_and_normalized_filters() {
    let filters = HistoryFilters::from_query(&HistoryFilterQuery {
        history_workflow: Some("review-pipeline".to_owned()),
        history_trigger: Some("invalid".to_owned()),
        history_status: Some("completed".to_owned()),
    });
    let service = WorkflowService::new().expect("code-defined workflows should build");
    let state = HistoryPanelState::new(
        service.history_view().await,
        filters,
        "/workflows/review-pipeline/runs/".to_owned(),
    );

    assert_eq!(
        state.events_url(),
        "/events/history?after=0&history_workflow=review-pipeline&history_status=completed"
    );
}

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
