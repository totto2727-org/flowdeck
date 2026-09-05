use flowdeck::{RunTrigger, WorkflowError, WorkflowService};
use futures_core::Stream;
use garde::Validate;
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

use crate::{
    app::workflow_url,
    features::run_history::{HistoryFilterValues, HistoryFilters},
};

#[derive(Debug, Deserialize, Validate)]
#[serde(rename_all = "camelCase")]
struct StartSignals {
    #[garde(length(chars, min = 1, max = 128))]
    selected_workflow_id: String,
    #[garde(skip)]
    input: Value,
    #[serde(flatten)]
    #[garde(dive)]
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
    let validation = signals.validate();
    let workflow_id = signals.selected_workflow_id;
    let filters = HistoryFilters::from_values(&signals.history);
    let result = match validation {
        Ok(()) => {
            service
                .start(&workflow_id, signals.input, RunTrigger::Manual)
                .await
        }
        Err(error) => Err(WorkflowError::InvalidInput {
            message: format!("invalid request signals: {error}"),
        }),
    };
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
    use garde::Validate;
    use serde_json::json;

    use super::{HistoryFilters, StartSignals};

    #[test]
    fn blank_workflow_signal_is_rejected_before_execution() {
        let signals = serde_json::from_value::<StartSignals>(json!({
            "selectedWorkflowId": "", "input": {}
        }))
        .expect("structurally valid signals");
        let _ = signals
            .validate()
            .expect_err("blank workflow IDs fail validation");
    }

    #[test]
    fn start_signals_without_history_filters_defaults_to_all() {
        let signals = serde_json::from_value::<StartSignals>(json!({
            "selectedWorkflowId": "demo-workflow",
            "input": { "label": "local check", "step_delay_ms": 350 }
        }))
        .expect("the documented request shape should deserialize");

        assert_eq!(
            HistoryFilters::from_values(&signals.history),
            HistoryFilters::default()
        );
    }
}
