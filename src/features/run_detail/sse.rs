use futures_core::Stream;
use tokio::sync::broadcast::error::RecvError;
use topcoat::{
    Result,
    context::{Cx, app_context},
    datastar::{ExecuteScript, PatchElements},
    router::{
        content::sse::{Event, KeepAlive, Sse},
        path_param, route,
    },
};
use workflow_console_experiment::{RunId, WorkflowEvent, WorkflowService};

use super::fragments::render_run_inspector;

#[path_param]
struct RunEventPath(str);

#[route(GET "/events/runs/{run_event_path}")]
async fn run_events(cx: &Cx) -> Result<Sse<impl Stream<Item = Result<Event>> + use<>>> {
    let service = app_context::<WorkflowService>(cx).clone();
    let selected_run_id = path_param::<RunEventPath>(cx).to_owned();
    let mut receiver = service.subscribe();
    let initial = render_run_inspector(&service, &selected_run_id).await?;
    let stream = async_stream::stream! {
        if let Some(html) = initial {
            yield Ok(PatchElements::new(html).into());
        }
        loop {
            match receiver.recv().await {
                Ok(event) if event_run_id(&event).is_some_and(|run_id| run_id.as_str() == selected_run_id) => {
                    if let Some(html) = render_run_inspector(&service, &selected_run_id).await? {
                        yield Ok(PatchElements::new(html).into());
                    }
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    yield Ok(ExecuteScript::new("window.location.reload()").into());
                    return;
                }
                Err(RecvError::Closed) => return,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::new()))
}

const fn event_run_id(event: &WorkflowEvent) -> Option<&RunId> {
    match event {
        WorkflowEvent::RunStarted { run_id, .. }
        | WorkflowEvent::NodeStarted { run_id, .. }
        | WorkflowEvent::NodeCompleted { run_id, .. }
        | WorkflowEvent::RunCompleted { run_id, .. }
        | WorkflowEvent::RunFailed { run_id, .. }
        | WorkflowEvent::RunSkipped { run_id, .. } => Some(run_id),
        _ => None,
    }
}
