use serde_json::to_string_pretty;
use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{RunSnapshot, StepTrace, StepTraceStatus};

use super::step_history::execution_history;
use crate::features::presentation::{step_elapsed, step_status, timestamp};

#[component]
pub(super) async fn run_traces(run: RunSnapshot) -> Result {
    let run_id = run.run_id.to_string();
    let definition = workflow_console_experiment::workflow_definitions()
        .iter()
        .find(|definition| definition.workflow_id == run.workflow_id);
    let latest = run.steps.last();
    let follow_latest = latest.map(|step| {
        format!(
            "$traceFollowLatest && ($selectedTraceKind = 'node', $selectedTraceId = '{}', $selectedStepId = '{}')",
            step.node_id, step.step_id
        )
    });
    view! {
        <div class="mt-4" data-init=(follow_latest)>
            execution_history(steps: run.steps.clone())
            for node in definition.map_or(&[][..], |definition| definition.nodes) {
                trace_panel(
                    run_id: run_id.clone(),
                    kind: "node",
                    target_id: node.id,
                    label: format!("{} node", node.label),
                    steps: run
                        .steps
                        .iter()
                        .filter(|step| step.node_id == node.id)
                        .cloned()
                        .collect()
                )
            }
            for edge in definition.map_or(&[][..], |definition| definition.edges) {
                trace_panel(
                    run_id: run_id.clone(),
                    kind: "edge",
                    target_id: edge.id,
                    label: format!("{} → {} edge", edge.from, edge.to),
                    steps: run
                        .steps
                        .iter()
                        .filter(|step| step.selected_edge.as_deref() == Some(edge.id))
                        .cloned()
                        .collect()
                )
            }
        </div>
    }
}

#[component]
async fn trace_panel(
    run_id: String,
    kind: &'static str,
    target_id: &'static str,
    label: String,
    steps: Vec<StepTrace>,
) -> Result {
    let visible = format!(
        "$selectedRunId === '{run_id}' && $selectedTraceKind === '{kind}' && $selectedTraceId === '{target_id}'"
    );
    let latest_step_id = steps.last().map(|step| step.step_id.to_string());
    view! {
        <section
            class="grid gap-4 rounded-control border border-border bg-surface-elevated p-4"
            data-show=(visible)
            aria-labelledby=(format!("trace-title-{run_id}-{kind}-{target_id}"))
        >
            <div class="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p
                        class="text-xs font-semibold uppercase tracking-label text-text-muted"
                    >
                        "Step trace"
                    </p>
                    <h3
                        class="text-xl font-semibold"
                        id=(format!("trace-title-{run_id}-{kind}-{target_id}"))
                    >
                        (label)
                    </h3>
                </div>
                if let Some(latest_step_id) = latest_step_id {
                    <div class="grid min-w-[var(--summary-min)] gap-2">
                        <label class="grid gap-1 text-sm font-semibold text-text-secondary" for=(format!("trace-execution-{run_id}-{kind}-{target_id}"))>
                            <span>"Execution"</span>
                            <select
                                id=(format!("trace-execution-{run_id}-{kind}-{target_id}"))
                                class="min-h-[var(--control-min)] min-w-0 rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                                data-bind="selectedStepId"
                                data-on:change="$traceFollowLatest = false"
                            >
                                for step in steps.iter().rev() {
                                    <option value=(step.step_id.to_string())>
                                        (format!("#{} · execution {} · {}", step.step_id, step.node_execution, step_status(step)))
                                    </option>
                                }
                            </select>
                        </label>
                        <button
                            type="button"
                            class="min-h-[var(--control-min)] rounded-control border border-border px-3 text-sm font-semibold text-text-secondary transition-[filter] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110"
                            data-on:click=(format!("$traceFollowLatest = true; $selectedStepId = '{latest_step_id}'"))
                        >
                            "Follow latest"
                        </button>
                    </div>
                }
            </div>
            if steps.is_empty() {
                <p class="text-sm text-text-muted">"No execution captured for this target."</p>
            }
            for step in steps {
                trace_detail(step: step)
            }
        </section>
    }
}

#[component]
async fn trace_detail(step: StepTrace) -> Result {
    let visible = format!("$selectedStepId === '{}'", step.step_id);
    let (status, started, finished, duration, selected_edge, state, output) =
        trace_values(Some(&step));
    view! {
        <div class="grid gap-4" data-show=(visible)>
            <span class="text-sm font-semibold text-text-secondary" data-testid="trace-status">
                (status)
            </span>
            <dl class="grid grid-cols-2 gap-3 max-trace:grid-cols-1">
                <div>
                    <dt class="text-xs font-semibold text-text-muted">"Started"</dt>
                    <dd
                        class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]"
                    >
                        (started)
                    </dd>
                </div>
                <div>
                    <dt class="text-xs font-semibold text-text-muted">"Finished"</dt>
                    <dd
                        class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]"
                    >
                        (finished)
                    </dd>
                </div>
                <div>
                    <dt class="text-xs font-semibold text-text-muted">"Duration"</dt>
                    <dd class="mt-1 font-mono text-[length:var(--type-code)]">
                        (duration)
                    </dd>
                </div>
                <div>
                    <dt class="text-xs font-semibold text-text-muted">
                        "Selected edge"
                    </dt>
                    <dd
                        class="mt-1 break-anywhere font-mono text-[length:var(--type-code)]"
                    >
                        (selected_edge)
                    </dd>
                </div>
            </dl>
            <div class="grid grid-cols-2 gap-3 max-trace:grid-cols-1">
                <div>
                    <p
                        class="text-xs font-semibold uppercase tracking-label text-text-muted"
                    >
                        "State after node"
                    </p>
                    <pre
                        class="mt-2 min-h-[var(--trace-output-min)] overflow-auto whitespace-pre-wrap [word-break:keep-all] rounded-control bg-canvas p-3 font-mono text-[length:var(--type-code)] text-text-secondary"
                        data-testid="trace-state"
                    >
                        (state)
                    </pre>
                </div>
                <div>
                    <p
                        class="text-xs font-semibold uppercase tracking-label text-text-muted"
                    >
                        "Output / error"
                    </p>
                    <pre
                        class="mt-2 min-h-[var(--trace-output-min)] overflow-auto whitespace-pre-wrap [word-break:keep-all] rounded-control bg-canvas p-3 font-mono text-[length:var(--type-code)] text-text-secondary"
                        data-testid="trace-output"
                    >
                        (output)
                    </pre>
                </div>
            </div>
        </div>
    }
}

fn trace_values(
    step: Option<&StepTrace>,
) -> (String, String, String, String, String, String, String) {
    let Some(step) = step else {
        return (
            "Unavailable".to_owned(),
            "—".to_owned(),
            "—".to_owned(),
            "—".to_owned(),
            "—".to_owned(),
            "No state captured".to_owned(),
            "No output captured".to_owned(),
        );
    };
    let output = match &step.status {
        StepTraceStatus::Failed { message } => message.clone(),
        _ => step
            .output
            .clone()
            .unwrap_or_else(|| "No output captured".to_owned()),
    };
    (
        step_status(step).to_owned(),
        timestamp(Some(step.started_at)),
        timestamp(step.finished_at),
        step_elapsed(step),
        step.selected_edge.clone().unwrap_or_else(|| "—".to_owned()),
        to_string_pretty(&step.state).unwrap_or_else(|_| "State serialization failed".to_owned()),
        output,
    )
}
