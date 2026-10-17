use flowdeck::{WorkflowEvent, WorkflowService};
use futures_core::Stream;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use topcoat::{
    Result,
    context::{Cx, app_context},
    datastar::{ElementPatchMode, PatchElements},
    router::{
        content::sse::{Event, KeepAlive, Sse},
        parse_query_params, route,
    },
};

use super::{
    filter::{HistoryFilterQuery, HistoryFilters},
    fragments::render_history_body,
};

#[derive(Deserialize)]
#[allow(
    clippy::struct_field_names,
    reason = "This query DTO mirrors the stable history-prefixed URL parameters."
)]
struct HistoryEventsQuery {
    history_workflow: Option<String>,
    history_trigger: Option<String>,
    history_status: Option<String>,
}

#[route(GET "/events/history")]
async fn history_events(cx: &Cx) -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let service = app_context::<WorkflowService>(cx).clone();
    let filters = history_request(cx)?;
    let mut receiver = service.subscribe();
    let initial = history_patch(&service, &filters).await?;
    let stream = async_stream::stream! {
        yield Ok(initial);
        loop {
            match receiver.recv().await {
                Ok(event) if history_event_changes_table(&event) => {
                    yield Ok(history_patch(&service, &filters).await?);
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    yield Ok(history_patch(&service, &filters).await?);
                }
                Err(RecvError::Closed) => return,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::new()))
}

fn history_request(cx: &Cx) -> Result<HistoryFilters> {
    let query = parse_query_params::<HistoryEventsQuery>(cx)?;
    Ok(HistoryFilters::from_query(&HistoryFilterQuery {
        history_workflow: query.history_workflow,
        history_trigger: query.history_trigger,
        history_status: query.history_status,
    }))
}

async fn history_patch(service: &WorkflowService, filters: &HistoryFilters) -> Result<Event> {
    let html = render_history_body(service.history_view().await, filters).await?;
    Ok(PatchElements::new(html)
        .selector("#run-history-body")
        .mode(ElementPatchMode::Inner)
        .into())
}

pub(crate) const fn history_event_changes_table(event: &WorkflowEvent) -> bool {
    match event {
        WorkflowEvent::RunStarted { .. }
        | WorkflowEvent::RunCompleted { .. }
        | WorkflowEvent::RunFailed { .. }
        | WorkflowEvent::RunSkipped { .. } => true,
        WorkflowEvent::NodeStarted { .. } | WorkflowEvent::NodeCompleted { .. } => false,
    }
}
