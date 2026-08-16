use serde_json::to_string_pretty;
use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{RunSnapshot, StepTrace, StepTraceStatus};

use super::presentation::{step_elapsed, step_status, timestamp};

#[component]
pub(super) async fn run_traces(run: RunSnapshot) -> Result {
    let run_id = run.run_id.to_string();
    view! {
        <div class="mt-4">
            for node in workflow_console_experiment::workflow_definitions().iter().find(|definition| definition.workflow_id == run.workflow_id).map_or(&[][..], |definition| definition.nodes) {
                trace_panel(
                    run_id: run_id.clone(),
                    kind: "node",
                    target_id: node.id,
                    label: format!("{} node", node.label),
                    step: run.steps.iter().rev().find(|step| step.node_id == node.id).cloned(),
                )
            }
            for edge in workflow_console_experiment::workflow_definitions().iter().find(|definition| definition.workflow_id == run.workflow_id).map_or(&[][..], |definition| definition.edges) {
                trace_panel(
                    run_id: run_id.clone(),
                    kind: "edge",
                    target_id: edge.id,
                    label: format!("{} → {} edge", edge.from, edge.to),
                    step: run.steps.iter().rev().find(|step| step.selected_edge.as_deref() == Some(edge.id)).cloned(),
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
    step: Option<StepTrace>,
) -> Result {
    let visible = format!(
        "$selectedRunId === '{run_id}' && $selectedTraceKind === '{kind}' && $selectedTraceId === '{target_id}'"
    );
    let (status, started, finished, duration, selected_edge, state, output) =
        trace_values(step.as_ref());
    view! {
        <section class="grid gap-4 rounded-control border border-border bg-surface-elevated p-4" data-show=(visible) aria-labelledby=(format!("trace-title-{run_id}-{kind}-{target_id}"))>
            <div class="flex items-start justify-between gap-4">
                <div><p class="text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">"Step trace"</p><h3 class="text-lg font-semibold" id=(format!("trace-title-{run_id}-{kind}-{target_id}"))>(label)</h3></div>
                <span class="text-sm font-semibold text-text-secondary" data-testid="trace-status">(status)</span>
            </div>
            <dl class="grid grid-cols-2 gap-3 max-[30rem]:grid-cols-1">
                <div><dt class="text-xs font-semibold text-text-muted">"Started"</dt><dd class="mt-1 break-anywhere font-mono text-[0.8125rem]">(started)</dd></div>
                <div><dt class="text-xs font-semibold text-text-muted">"Finished"</dt><dd class="mt-1 break-anywhere font-mono text-[0.8125rem]">(finished)</dd></div>
                <div><dt class="text-xs font-semibold text-text-muted">"Duration"</dt><dd class="mt-1 font-mono text-[0.8125rem]">(duration)</dd></div>
                <div><dt class="text-xs font-semibold text-text-muted">"Selected edge"</dt><dd class="mt-1 break-anywhere font-mono text-[0.8125rem]">(selected_edge)</dd></div>
            </dl>
            <div class="grid grid-cols-2 gap-3 max-[30rem]:grid-cols-1">
                <div><p class="text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">"State after node"</p><pre class="mt-2 min-h-28 overflow-auto whitespace-pre-wrap break-anywhere rounded-control bg-canvas p-3 font-mono text-[0.8125rem] text-text-secondary" data-testid="trace-state">(state)</pre></div>
                <div><p class="text-xs font-semibold uppercase tracking-[0.04em] text-text-muted">"Output / error"</p><pre class="mt-2 min-h-28 overflow-auto whitespace-pre-wrap break-anywhere rounded-control bg-canvas p-3 font-mono text-[0.8125rem] text-text-secondary" data-testid="trace-output">(output)</pre></div>
            </div>
        </section>
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
