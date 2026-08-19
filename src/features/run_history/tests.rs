use serde_json::json;
use tokio::time::{Duration, sleep};
use workflow_console_experiment::{
    HistoryReplay, HistoryRevision, RunStatus, RunTrigger, WorkflowService, workflow_id,
};

use super::{
    HistoryFilterQuery, HistoryFilterValues, HistoryFilters, HistoryPanelState,
    component::history_panel,
    membership::FilteredHistoryMembership,
    sse::{
        HistoryMembershipChange, HistoryTransition, RevisionAction, delta_events,
        history_transition, replay_cursor, revision_action,
    },
};
use crate::app::workflow_url;

#[test]
fn history_transition_classifies_all_filter_membership_changes() {
    assert_eq!(
        history_transition(HistoryMembershipChange::Entered { was_empty: true }),
        HistoryTransition::InsertFirst
    );
    assert_eq!(
        history_transition(HistoryMembershipChange::Entered { was_empty: false }),
        HistoryTransition::Insert
    );
    assert_eq!(
        history_transition(HistoryMembershipChange::Stayed),
        HistoryTransition::Replace
    );
    assert_eq!(
        history_transition(HistoryMembershipChange::Left { is_empty: true }),
        HistoryTransition::RemoveAndEmpty
    );
    assert_eq!(
        history_transition(HistoryMembershipChange::Outside),
        HistoryTransition::Ignore
    );
}

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

#[test]
fn revision_action_ignores_duplicates_and_reloads_on_gaps() {
    let last = HistoryRevision::new(4);

    assert_eq!(
        revision_action(last, HistoryRevision::new(4)),
        RevisionAction::Ignore
    );
    assert_eq!(
        revision_action(last, HistoryRevision::new(5)),
        RevisionAction::Apply
    );
    assert_eq!(
        revision_action(last, HistoryRevision::new(6)),
        RevisionAction::Reload
    );
}

#[test]
fn replay_cursor_uses_the_greatest_valid_client_revision() {
    assert_eq!(replay_cursor(7, Some("9")), HistoryRevision::new(9));
    assert_eq!(replay_cursor(7, Some("4")), HistoryRevision::new(7));
    assert_eq!(replay_cursor(7, Some("invalid")), HistoryRevision::new(7));
    assert_eq!(replay_cursor(7, None), HistoryRevision::new(7));
}

#[tokio::test]
async fn one_history_revision_is_emitted_as_one_sse_event() -> Result<(), Box<dyn std::error::Error>>
{
    let service = WorkflowService::new()?;
    assert!(
        service
            .start(
                "review-pipeline",
                json!({"subject": "atomic event", "reviewer": "qa"}),
                RunTrigger::Manual,
            )
            .await
            .is_ok()
    );
    let filters = HistoryFilters::from_query(&HistoryFilterQuery::default());
    let (view, replay) = service.history_view_since(HistoryRevision::new(0)).await;
    let mut membership = FilteredHistoryMembership::at_cursor(&view, &replay, &filters);
    let HistoryReplay::Changes(changes) = replay else {
        return Err(std::io::Error::other("initial history revision should be replayable").into());
    };
    let delta = changes
        .iter()
        .find(|delta| delta.before.is_none())
        .ok_or_else(|| std::io::Error::other("run insertion delta should be retained"))?;
    let transition = membership.apply(delta, &filters);
    let events = delta_events(&filters, delta, transition)
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;

    assert_eq!(events.len(), 1, "one revision must be reconnect-atomic");
    Ok(())
}

#[tokio::test]
async fn replayed_removals_add_empty_state_only_after_the_last_matching_row()
-> Result<(), Box<dyn std::error::Error>> {
    let service = WorkflowService::new()?;
    for subject in ["first", "second"] {
        assert!(
            service
                .start(
                    "review-pipeline",
                    json!({"subject": subject, "reviewer": "qa"}),
                    RunTrigger::Manual,
                )
                .await
                .is_ok()
        );
    }
    let cursor = service.history_view().await.revision;
    for _ in 0..50 {
        if service
            .list_runs()
            .await
            .iter()
            .all(|run| matches!(run.status, RunStatus::Completed))
        {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }
    let filters = HistoryFilters::from_query(&HistoryFilterQuery {
        history_status: Some("running".to_owned()),
        ..HistoryFilterQuery::default()
    });
    let (current, replay) = service.history_view_since(cursor).await;
    let mut membership = FilteredHistoryMembership::at_cursor(&current, &replay, &filters);
    let HistoryReplay::Changes(changes) = replay else {
        return Err(std::io::Error::other("completion changes should be replayable").into());
    };
    let transitions: Vec<_> = changes
        .iter()
        .filter_map(|delta| {
            let is_completion = delta
                .before
                .as_ref()
                .is_some_and(|run| matches!(run.status, RunStatus::Running))
                && delta
                    .after
                    .as_ref()
                    .is_some_and(|run| matches!(run.status, RunStatus::Completed));
            let transition = membership.apply(delta, &filters);
            is_completion.then_some(transition)
        })
        .collect();

    assert_eq!(
        transitions,
        [HistoryTransition::Remove, HistoryTransition::RemoveAndEmpty],
        "an earlier replayed removal must not render the empty state"
    );
    Ok(())
}
