use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{RunSnapshot, RunStatus, RunTrigger, workflow_definitions};

use super::{
    presentation::{elapsed, run_status, trigger},
    topology::workflow_topology,
    trace::run_traces,
};

#[component]
pub(super) async fn console_content(runs: Vec<RunSnapshot>) -> Result {
    let selected = runs.first().cloned();
    view! {
        <div id="console-content" class="grid min-w-0 gap-4">
            selected_inspector_host(run: selected)
            run_history(runs: runs)
        </div>
    }
}

#[component]
pub(super) async fn selected_inspector_host(run: Option<RunSnapshot>) -> Result {
    view! {
        <div id="selected-inspector-host" class="min-w-0">
            if let Some(run) = run { run_inspector(run: run) } else { idle_inspector() }
        </div>
    }
}

#[component]
pub(super) async fn recovery_inspector_host(runs: Vec<RunSnapshot>) -> Result {
    view! {
        <div id="selected-inspector-host" class="min-w-0">
            idle_inspector()
            for run in runs {
                let run_id = run.run_id.to_string();
                <div data-show=(format!("$selectedRunId === '{run_id}'"))>
                    run_inspector(run: run)
                </div>
            }
        </div>
    }
}

#[component]
async fn idle_inspector() -> Result {
    view! {
        <section class="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-panel" data-show="$selectedRunId === ''" aria-labelledby="inspector-title-idle">
            <div class="flex items-start justify-between gap-4"><div><p class="text-xs font-semibold uppercase tracking-label text-text-muted">"Selected workflow"</p><h2 id="inspector-title-idle" class="text-xl font-semibold">"Execution route"</h2></div><p class="rounded-control border border-current px-2 py-1 text-sm font-semibold text-text-secondary" role="status" aria-live="polite">"Idle"</p></div>
            <p class="my-4 text-sm text-text-muted">"Start a workflow or select a retained run to inspect execution state and traces."</p>
            for definition in workflow_definitions() {
                <div data-show=(format!("$selectedWorkflowId === '{}'", definition.workflow_id))>
                    workflow_topology(definition: definition, run: None)
                </div>
            }
        </section>
    }
}

#[component]
pub(super) async fn run_inspector(run: RunSnapshot) -> Result {
    let run_id = run.run_id.to_string();
    let definition = workflow_definitions()
        .iter()
        .find(|definition| definition.workflow_id == run.workflow_id);
    let error = match &run.status {
        RunStatus::Failed { message } => Some(message.clone()),
        _ => None,
    };
    view! {
        <section id=(format!("run-{run_id}-inspector")) class="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-panel" aria-labelledby=(format!("inspector-title-{run_id}"))>
            <div class="flex items-start justify-between gap-4">
                <div><p class="text-xs font-semibold uppercase tracking-label text-text-muted">"Selected run"</p><h2 class="text-xl font-semibold" id=(format!("inspector-title-{run_id}"))>"Execution route"</h2></div>
                <p class="rounded-control border border-current px-2 py-1 text-sm font-semibold text-text-secondary data-[status=Running]:text-status-healthy data-[status=Completed]:text-status-healthy data-[status=Failed]:text-status-error" data-status=(run_status(&run)) role="status" aria-live="polite">(run_status(&run))</p>
            </div>
            <dl class="my-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(var(--summary-min),1fr)]">
                <div><dt class="text-xs font-semibold text-text-muted">"Workflow"</dt><dd class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]">(run.workflow_id.clone())</dd></div>
                <div><dt class="text-xs font-semibold text-text-muted">"Trigger"</dt><dd class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]">(trigger(&run))</dd></div>
                <div><dt class="text-xs font-semibold text-text-muted">"Input"</dt><dd class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]">(run.input.summary())</dd></div>
                <div><dt class="text-xs font-semibold text-text-muted">"Elapsed"</dt><dd class="mt-1 font-mono text-[length:var(--type-code)]">(elapsed(&run))</dd></div>
                <div class="lg:col-span-2"><dt class="text-xs font-semibold text-text-muted">"Route"</dt><dd class="mt-1 break-normal font-mono text-[length:var(--type-code)]" data-testid="route-summary">(run.route_summary.clone())</dd></div>
            </dl>
            if let Some(message) = error { <p class="mb-4 border-l-[var(--error-border)] border-status-error bg-surface-elevated p-3" role="alert">(message)</p> }
            <div class="mb-3 flex flex-wrap gap-4 text-sm text-text-secondary" aria-label="Topology state legend"><span class="inline-flex items-center gap-2"><i class="size-3 rounded-full border border-text-muted"></i>"Idle"</span><span class="inline-flex items-center gap-2"><i class="size-3 rounded-full border border-status-healthy bg-status-healthy"></i>"Active"</span><span class="inline-flex items-center gap-2"><i class="size-3 rounded-full border border-accent-hover bg-accent-hover"></i>"Traversed"</span></div>
            if let Some(definition) = definition { workflow_topology(definition: definition, run: Some(run.clone())) }
            run_traces(run: run)
        </section>
    }
}

#[component]
pub(super) async fn run_history(runs: Vec<RunSnapshot>) -> Result {
    view! {
        <section id="run-history-region" class="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-panel" aria-labelledby="history-title">
            <div class="flex items-start justify-between gap-4"><div><p class="text-xs font-semibold uppercase tracking-label text-text-muted">"Process lifetime"</p><h2 id="history-title" class="text-xl font-semibold">"Run history"</h2></div></div>
            <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" role="group" aria-labelledby="history-filters-title">
                <h3 id="history-filters-title" class="sr-only">"Filter run history"</h3>
                <label class="grid gap-1 text-sm font-semibold text-text-secondary" for="history-workflow-filter"><span>"Workflow"</span>
                    <select id="history-workflow-filter" class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset" data-bind="historyWorkflowFilter">
                        <option value="all">"All workflows"</option>
                        for definition in workflow_definitions() { <option value=(definition.workflow_id)>(definition.name)</option> }
                    </select>
                </label>
                <label class="grid gap-1 text-sm font-semibold text-text-secondary" for="history-trigger-filter"><span>"Trigger"</span>
                    <select id="history-trigger-filter" class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset" data-bind="historyTriggerFilter">
                        <option value="all">"All triggers"</option><option value="manual">"Manual"</option><option value="cron">"Cron"</option>
                    </select>
                </label>
                <label class="grid gap-1 text-sm font-semibold text-text-secondary" for="history-status-filter"><span>"Status"</span>
                    <select id="history-status-filter" class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset" data-bind="historyStatusFilter">
                        <option value="all">"All statuses"</option><option value="running">"Running"</option><option value="completed">"Completed"</option><option value="failed">"Failed"</option>
                    </select>
                </label>
                <button type="button" class="min-h-[var(--control-min)] self-end rounded-control border border-accent-hover bg-accent px-4 font-semibold text-text-primary shadow-inset transition-[filter,transform] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50" data-attr:disabled="$historyWorkflowFilter === 'all' && $historyTriggerFilter === 'all' && $historyStatusFilter === 'all'" data-on:click="$historyWorkflowFilter = 'all'; $historyTriggerFilter = 'all'; $historyStatusFilter = 'all'">"Reset filters"</button>
            </div>
            <div class="max-w-full min-w-0 overflow-x-auto" tabindex="0" aria-label="Run history, horizontally scrollable">
                <table class="w-full min-w-[var(--table-min)] border-collapse text-sm"><thead><tr> for heading in ["Run ID", "Workflow", "Trigger", "Input", "Status", "Route", "Elapsed"] { <th class="border-b border-border p-3 text-left align-top text-xs font-semibold text-text-muted" scope="col">(heading)</th> } </tr></thead>
                    <tbody>
                        if runs.is_empty() { <tr><td class="border-b border-border p-3" colspan="7">"No runs yet. Select and start a code-defined workflow to inspect it here."</td></tr> }
                        for run in runs {
                            let run_id = run.run_id.to_string();
                            <tr data-show=(history_visibility_expression(&run)) data-attr:aria-current=(format!("$selectedRunId === '{run_id}' ? 'true' : 'false'")) class="aria-[current=true]:bg-surface-elevated">
                                <td class="border-b border-border p-3 align-top"><button class="border-0 bg-transparent p-0 font-mono text-[length:var(--type-code)] text-accent-hover underline" type="button" data-on:click=(history_expression(&run))>(run_id)</button></td>
                                <td class="border-b border-border p-3 align-top">(run.workflow_id.clone())</td><td class="border-b border-border p-3 align-top">(trigger(&run))</td><td class="border-b border-border p-3 align-top">(run.input.summary())</td><td class="border-b border-border p-3 align-top">(run_status(&run))</td><td class="border-b border-border p-3 align-top">(run.route_summary.clone())</td><td class="border-b border-border p-3 align-top">(elapsed(&run))</td>
                            </tr>
                        }
                    </tbody>
                </table>
            </div>
        </section>
    }
}

fn history_visibility_expression(run: &RunSnapshot) -> String {
    let trigger_filter = match &run.trigger {
        RunTrigger::Manual => "manual",
        RunTrigger::Cron { .. } => "cron",
        trigger => {
            tracing::warn!(?trigger, "unsupported run trigger in history filter");
            "other"
        }
    };
    let status_filter = match &run.status {
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Failed { .. } => "failed",
        status => {
            tracing::warn!(?status, "unsupported run status in history filter");
            "other"
        }
    };
    format!(
        "($historyWorkflowFilter === 'all' || $historyWorkflowFilter === '{}') && ($historyTriggerFilter === 'all' || $historyTriggerFilter === '{trigger_filter}') && ($historyStatusFilter === 'all' || $historyStatusFilter === '{status_filter}')",
        run.workflow_id
    )
}

fn history_expression(run: &RunSnapshot) -> String {
    let trace_id = run
        .current_node
        .as_deref()
        .or_else(|| run.steps.last().map(|step| step.node_id.as_str()))
        .unwrap_or("");
    format!(
        "$selectedRunId = '{}'; $selectedWorkflowId = '{}'; $selectedTraceKind = 'node'; $selectedTraceId = '{trace_id}'; $requestMessage = ''; @get('/actions/select-run')",
        run.run_id, run.workflow_id
    )
}
