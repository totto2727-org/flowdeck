use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::StepTrace;

use crate::features::presentation::{step_elapsed, step_status};

#[component]
pub(super) async fn execution_history(steps: Vec<StepTrace>) -> Result {
    view! {
        <section class="mb-4 rounded-control border border-border bg-surface-elevated p-4" aria-labelledby="execution-history-title">
            <p class="text-xs font-semibold uppercase tracking-label text-text-muted">"Run timeline"</p>
            <h3 id="execution-history-title" class="text-xl font-semibold">"Execution history"</h3>
            if steps.is_empty() {
                <p class="mt-3 text-sm text-text-muted">"No node execution has started."</p>
            } else {
                <ol class="mt-3 grid gap-2">
                    for step in steps {
                        <li>
                            <button
                                type="button"
                                class="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-control border border-border bg-canvas p-3 text-left text-text-secondary transition-[filter] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 aria-[current=true]:border-focus"
                                data-attr:aria-current=(format!("$selectedStepId === '{}' ? 'true' : 'false'", step.step_id))
                                data-on:click=(format!("$selectedTraceKind = 'node'; $selectedTraceId = '{}'; $selectedStepId = '{}'; $traceFollowLatest = false", step.node_id, step.step_id))
                            >
                                <span class="font-mono text-[length:var(--type-code)] text-text-muted">(format!("#{}", step.step_id))</span>
                                <span class="min-w-0">
                                    <strong class="block break-anywhere text-text-primary">(format!("{} · execution {}", step.node_id, step.node_execution))</strong>
                                    <span class="mt-1 block break-anywhere text-sm text-text-muted">
                                        (step.selected_edge.clone().map_or_else(|| "Terminal or pending".to_owned(), |edge| format!("Edge {edge}")))
                                    </span>
                                </span>
                                <span class="text-right text-sm">
                                    <strong class="block">(step_status(&step))</strong>
                                    <span class="mt-1 block font-mono text-[length:var(--type-code)] text-text-muted">(step_elapsed(&step))</span>
                                </span>
                            </button>
                        </li>
                    }
                </ol>
            }
        </section>
    }
}
