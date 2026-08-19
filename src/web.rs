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

use crate::features::run_history::{HistoryFilterValues, HistoryFilters};
use crate::web_page::workflow_url;

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
