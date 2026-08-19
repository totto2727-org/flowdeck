use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{workflow_definitions, workflow_input_form, workflow_schedules};

use crate::{features::run_history::HistoryFilters, web_page::workflow_url};

#[component]
pub(crate) async fn workflow_rail(selected_workflow_id: &str, filters: &HistoryFilters) -> Result {
    let schedules = workflow_schedules();
    let filter_suffix = filters.query_suffix();
    view! {
        <aside class="min-w-0 self-start rounded-panel border border-border bg-surface p-4 shadow-panel lg:sticky lg:top-6" aria-labelledby="workflows-title">
            <h2 id="workflows-title" class="text-xl font-semibold">"Workflows"</h2>
            <div class="mt-4 grid gap-3" role="group" aria-label="Code-defined workflows">
                for definition in workflow_definitions() {
                    <a
                        href=(format!("{}{}", workflow_url(definition.workflow_id, None), filter_suffix))
                        class="grid w-full gap-2 rounded-control border border-border bg-surface-elevated p-4 text-left text-text-primary shadow-inset transition-[filter] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 aria-[current=page]:border-focus"
                        data-attr:aria-current=(format!("$selectedWorkflowId === '{}' ? 'page' : 'false'", definition.workflow_id))
                    >
                        <span class="text-xs font-semibold uppercase tracking-label text-text-muted">"Code-defined"</span>
                        <strong>(definition.name)</strong>
                        <span class="text-sm text-text-muted">(definition.description)</span>
                        <code class="font-mono text-[length:var(--type-code)]">(definition.workflow_id)</code>
                        for schedule in schedules.iter().filter(|schedule| schedule.workflow_id == definition.workflow_id) {
                            <span class="grid gap-1 border-t border-border pt-3">
                                <span class="text-xs font-semibold uppercase tracking-label text-text-muted">"Cron schedule"</span>
                                <code class="break-anywhere font-mono text-[length:var(--type-code)] text-status-healthy">(schedule.cron_expression)</code>
                                <span class="text-sm text-text-muted">(schedule.input_summary)</span>
                            </span>
                        }
                    </a>
                }
            </div>
            for definition in workflow_definitions().iter().filter(|definition| definition.workflow_id == selected_workflow_id) {
                workflow_input_form(workflow_id: definition.workflow_id, active: true)
            }
        </aside>
    }
}
