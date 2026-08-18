use serde_json::json;
use tokio::time::{Duration, sleep};
use workflow_console_experiment::{
    HistoryReplay, HistoryRevision, RunStatus, RunTrigger, WorkflowService,
};

use super::{
    FilteredHistoryMembership, HistoryTransition, RevisionAction, delta_events, replay_cursor,
    revision_action,
};
use crate::history_filter::{HistoryFilterQuery, HistoryFilters};

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
