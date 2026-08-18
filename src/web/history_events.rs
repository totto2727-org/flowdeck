use futures_core::Stream;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use topcoat::{
    Result,
    context::{Cx, app_context},
    datastar::{ElementPatchMode, ExecuteScript, PatchElements},
    router::{
        content::sse::{Event, KeepAlive, Sse, last_event_id},
        parse_query_params, route,
    },
};
use workflow_console_experiment::{HistoryDelta, HistoryReplay, HistoryRevision, WorkflowService};

use crate::{
    history_filter::{HistoryFilterQuery, HistoryFilters},
    web_page::{render_history_empty, render_history_row},
};

#[path = "history_events/membership.rs"]
mod membership;
#[cfg(test)]
#[path = "history_events/tests.rs"]
mod tests;

use membership::FilteredHistoryMembership;

#[derive(Deserialize)]
struct HistoryEventsQuery {
    after: Option<u64>,
    history_workflow: Option<String>,
    history_trigger: Option<String>,
    history_status: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum HistoryTransition {
    InsertFirst,
    Insert,
    Replace,
    Remove,
    RemoveAndEmpty,
    Ignore,
}

#[derive(Clone, Copy)]
pub(super) enum HistoryMembershipChange {
    Entered { was_empty: bool },
    Stayed,
    Left { is_empty: bool },
    Outside,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RevisionAction {
    Apply,
    Ignore,
    Reload,
}

#[route(GET "/events/history")]
async fn history_events(cx: &Cx) -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let service = app_context::<WorkflowService>(cx).clone();
    let (after, filters) = history_request(cx)?;
    let mut receiver = service.subscribe_history();
    let (view, replay) = service.history_view_since(after).await;
    let stream = async_stream::stream! {
        let mut last = after;
        let mut membership = FilteredHistoryMembership::at_cursor(&view, &replay, &filters);
        match replay {
            HistoryReplay::Changes(changes) => {
                for delta in changes {
                    match revision_action(last, delta.revision) {
                        RevisionAction::Apply => {
                            let transition = membership.apply(&delta, &filters);
                            for event in delta_events(&filters, &delta, transition).await? {
                                yield Ok(event);
                            }
                            last = delta.revision;
                        }
                        RevisionAction::Ignore => {}
                        RevisionAction::Reload => {
                            yield Ok(reload_event());
                            return;
                        }
                    }
                }
            }
            HistoryReplay::Stale { .. } => {
                yield Ok(reload_event());
                return;
            }
            _ => {
                tracing::warn!("unknown history replay result; reloading the page");
                yield Ok(reload_event());
                return;
            }
        }
        loop {
            match receiver.recv().await {
                Ok(delta) => match revision_action(last, delta.revision) {
                    RevisionAction::Apply => {
                        let transition = membership.apply(&delta, &filters);
                        for event in delta_events(&filters, &delta, transition).await? {
                            yield Ok(event);
                        }
                        last = delta.revision;
                    }
                    RevisionAction::Ignore => {}
                    RevisionAction::Reload => {
                        yield Ok(reload_event());
                        return;
                    }
                },
                Err(RecvError::Lagged(_)) => {
                    yield Ok(reload_event());
                    return;
                }
                Err(RecvError::Closed) => return,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::new()))
}

fn history_request(cx: &Cx) -> Result<(HistoryRevision, HistoryFilters)> {
    let query = parse_query_params::<HistoryEventsQuery>(cx)?;
    let after = replay_cursor(query.after.unwrap_or_default(), last_event_id(cx));
    let filters = HistoryFilters::from_query(&HistoryFilterQuery {
        history_workflow: query.history_workflow,
        history_trigger: query.history_trigger,
        history_status: query.history_status,
    });
    Ok((after, filters))
}

async fn delta_events(
    filters: &HistoryFilters,
    delta: &HistoryDelta,
    transition: HistoryTransition,
) -> Result<Vec<Event>> {
    let row_selector = format!("#run-history-{}", delta.run_id);
    let revision_id = delta.revision.value().to_string();
    match transition {
        HistoryTransition::InsertFirst => {
            let Some(run) = delta.after.as_ref() else {
                return Ok(Vec::new());
            };
            Ok(vec![
                PatchElements::new(render_history_row(run, filters).await?)
                    .selector("#run-history-body")
                    .mode(ElementPatchMode::Inner)
                    .id(revision_id)
                    .into(),
            ])
        }
        HistoryTransition::Insert => {
            let Some(run) = delta.after.as_ref() else {
                return Ok(Vec::new());
            };
            Ok(vec![
                PatchElements::new(render_history_row(run, filters).await?)
                    .selector("#run-history-body")
                    .mode(ElementPatchMode::Prepend)
                    .id(revision_id)
                    .into(),
            ])
        }
        HistoryTransition::Replace => {
            let Some(run) = delta.after.as_ref() else {
                return Ok(Vec::new());
            };
            Ok(vec![
                PatchElements::new(render_history_row(run, filters).await?)
                    .selector(row_selector)
                    .id(revision_id)
                    .into(),
            ])
        }
        HistoryTransition::Remove => Ok(vec![
            PatchElements::remove(row_selector).id(revision_id).into(),
        ]),
        HistoryTransition::RemoveAndEmpty => Ok(vec![
            PatchElements::new(render_history_empty(filters).await?)
                .selector("#run-history-body")
                .mode(ElementPatchMode::Inner)
                .id(revision_id)
                .into(),
        ]),
        HistoryTransition::Ignore => Ok(Vec::new()),
    }
}

fn replay_cursor(query_after: u64, last_event_id: Option<&str>) -> HistoryRevision {
    let resumed_after = last_event_id.and_then(|value| value.parse::<u64>().ok());
    HistoryRevision::new(resumed_after.map_or(query_after, |value| value.max(query_after)))
}

pub(super) const fn history_transition(change: HistoryMembershipChange) -> HistoryTransition {
    match change {
        HistoryMembershipChange::Entered { was_empty: true } => HistoryTransition::InsertFirst,
        HistoryMembershipChange::Entered { was_empty: false } => HistoryTransition::Insert,
        HistoryMembershipChange::Stayed => HistoryTransition::Replace,
        HistoryMembershipChange::Left { is_empty: true } => HistoryTransition::RemoveAndEmpty,
        HistoryMembershipChange::Left { is_empty: false } => HistoryTransition::Remove,
        HistoryMembershipChange::Outside => HistoryTransition::Ignore,
    }
}

const fn revision_action(last: HistoryRevision, next: HistoryRevision) -> RevisionAction {
    if next.value() <= last.value() {
        RevisionAction::Ignore
    } else if next.value() == last.value().saturating_add(1) {
        RevisionAction::Apply
    } else {
        RevisionAction::Reload
    }
}

fn reload_event() -> Event {
    ExecuteScript::new("window.location.reload()").into()
}
