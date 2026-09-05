use flowdeck::{RunTrigger, WorkflowService, workflow_id};
use serde_json::json;

use super::{
    HistoryFilterQuery, HistoryFilterValues, HistoryFilters, HistoryPanelState,
    component::history_panel, sse::history_event_changes_table,
};
use crate::app::workflow_url;

#[tokio::test]
async fn run_history_renders_url_driven_filters_and_full_snapshot_rows() {
    let service = WorkflowService::new()
        .await
        .expect("code-defined workflows should build");
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
            service.history_view().await.expect("history should load"),
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
    assert!(html.contains("/events/history?history_workflow=review-pipeline"));
    assert!(!html.contains("after="));
    assert!(!html.contains(&demo.run_id.to_string()));
    assert!(html.contains(&format!(
        "href=\"/workflows/review-pipeline/runs/{}?history_workflow=review-pipeline\"",
        review.run_id
    )));
}

#[tokio::test]
async fn history_events_url_contains_only_normalized_filters() {
    let filters = HistoryFilters::from_query(&HistoryFilterQuery {
        history_workflow: Some("review-pipeline".to_owned()),
        history_trigger: Some("invalid".to_owned()),
        history_status: Some("completed".to_owned()),
    });
    let service = WorkflowService::new()
        .await
        .expect("code-defined workflows should build");
    let state = HistoryPanelState::new(
        service.history_view().await.expect("history should load"),
        filters,
        "/workflows/review-pipeline/runs/".to_owned(),
    );

    assert_eq!(
        state.events_url(),
        "/events/history?history_workflow=review-pipeline&history_status=completed"
    );
}

#[tokio::test]
async fn history_invalidation_uses_run_events_and_ignores_step_events() {
    let service = WorkflowService::new()
        .await
        .expect("code-defined workflows should build");
    let mut events = service.subscribe();
    let _ = service
        .start(
            "review-pipeline",
            json!({ "subject": "invalidation", "reviewer": "qa" }),
            RunTrigger::Manual,
        )
        .await
        .expect("review workflow should start");

    let run_started = events.recv().await.expect("run start should be broadcast");
    let node_started = events.recv().await.expect("node start should be broadcast");

    assert!(history_event_changes_table(&run_started));
    assert!(!history_event_changes_table(&node_started));
}
