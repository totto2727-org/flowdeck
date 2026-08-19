use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::RunSnapshot;

use crate::features::{
    run_detail::selected_inspector_host,
    run_history::{HistoryPanelState, history_panel},
};

#[component]
pub(super) async fn console_content(
    selected_workflow_id: &str,
    selected: Option<RunSnapshot>,
    history: HistoryPanelState,
) -> Result {
    view! {
        <div id="console-content" class="grid min-w-0 gap-4">
            selected_inspector_host(
                selected_workflow_id: selected_workflow_id,
                run: selected
            )
            history_panel(state: history)
        </div>
    }
}
