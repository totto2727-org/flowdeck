use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use topcoat::{
    Result,
    context::{Cx, app_context},
    datastar::{ExecuteScript, PatchSignals, Signals},
    router::{
        content::sse::{Event, Sse},
        route,
    },
};
use workflow_console_experiment::{RunTrigger, WorkflowService};

use crate::history_filter::{HistoryFilterValues, HistoryFilters};
use crate::web_page::workflow_url;

#[path = "web/history_events.rs"]
mod history_events;
#[path = "web/run_events.rs"]
mod run_events;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSignals {
    selected_workflow_id: String,
    input: Value,
    #[serde(flatten)]
    history: HistoryFilterValues,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartPatch {
    request_message: String,
}

#[route(POST "/actions/runs")]
async fn start_run(
    cx: &Cx,
    Signals(signals): Signals<StartSignals>,
) -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let service = app_context::<WorkflowService>(cx);
    let workflow_id = signals.selected_workflow_id;
    let filters = HistoryFilters::from_values(&signals.history);
    let result = service
        .start(&workflow_id, signals.input, RunTrigger::Manual)
        .await;
    let event = match result {
        Ok(run) => {
            let run_id = run.run_id.to_string();
            let run_url = format!(
                "{}{}",
                workflow_url(&run.workflow_id, Some(&run_id)),
                filters.query_suffix()
            );
            let run_url = serde_json::to_string(&run_url)?;
            ExecuteScript::new(format!("window.location.assign({run_url})")).into()
        }
        Err(error) => PatchSignals::json(&StartPatch {
            request_message: error.to_string(),
        })?
        .into(),
    };
    let stream = async_stream::stream! {
        yield Ok(event);
    };
    Ok(Sse::new(stream))
}

#[cfg(test)]
mod tests {
    use super::history_events::{HistoryMembershipChange, HistoryTransition, history_transition};

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
}
