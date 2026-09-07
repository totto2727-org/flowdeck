use flowdeck::WorkflowService;
use topcoat::{Result, view::view};

use super::component::run_inspector;

pub(super) async fn render_run_inspector(
    service: &WorkflowService,
    run_id: &str,
) -> Result<Option<String>> {
    let Some(run) = service
        .list_runs()
        .await?
        .into_iter()
        .find(|run| run.run_id.as_str() == run_id)
    else {
        return Ok(None);
    };
    let cx = topcoat::context::CxTestBuilder::new().build();
    let __cx = &cx;
    let rendered = view! { run_inspector(run: run) }?;
    Ok(Some(rendered.render(&cx)))
}
