use serde_json::json;
use workflow_console_experiment::{RunTrigger, WorkflowService};

use super::{document::initial_signals, rail::workflow_rail};
use crate::features::run_history::{HistoryFilterQuery, HistoryFilterValues, HistoryFilters};

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
