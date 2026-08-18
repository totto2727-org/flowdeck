#![allow(
    clippy::too_many_lines,
    reason = "Topcoat expands the cohesive history panel markup across its controls and table."
)]

use topcoat::{
    Result,
    view::{component, view},
};
use workflow_console_experiment::{
    HistoryRevision, HistoryView, RunSnapshot, workflow_definitions,
};

use super::{
    presentation::{elapsed, run_status, trigger},
    workflow_url,
};
use crate::history_filter::HistoryFilters;

pub(super) struct HistoryPanelState {
    runs: Vec<RunSnapshot>,
    filters: HistoryFilters,
    page_path: String,
    revision: HistoryRevision,
}

impl HistoryPanelState {
    pub(super) fn new(
        mut history: HistoryView,
        filters: HistoryFilters,
        page_path: String,
    ) -> Self {
        history.runs.reverse();
        history.runs.retain(|run| filters.matches(run));
        Self {
            runs: history.runs,
            filters,
            page_path,
            revision: history.revision,
        }
    }

    pub(super) fn events_url(&self) -> String {
        let suffix = self.filters.query_suffix();
        let filter_query = suffix.strip_prefix('?').unwrap_or_default();
        if filter_query.is_empty() {
            format!("/events/history?after={}", self.revision.value())
        } else {
            format!(
                "/events/history?after={}&{filter_query}",
                self.revision.value()
            )
        }
    }
}

#[component]
pub(super) async fn history_panel(state: HistoryPanelState) -> Result {
    let values = state.filters.values();
    let filters_active = state.filters.is_active();
    let events_url = state.events_url();
    view! {
        <section
            id="run-history-region"
            class="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-panel"
            aria-labelledby="history-title"
            data-init=(format!("@get('{events_url}')"))
        >
            <div class="flex items-start justify-between gap-4">
                <div>
                    <p class="text-xs font-semibold uppercase tracking-label text-text-muted">
                        "Process lifetime"
                    </p>
                    <h2 id="history-title" class="text-xl font-semibold">"Run history"</h2>
                </div>
            </div>
            <form
                method="get"
                action=(state.page_path.clone())
                class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
                aria-labelledby="history-filters-title"
            >
                <h3 id="history-filters-title" class="sr-only">"Filter run history"</h3>
                <label
                    class="grid gap-1 text-sm font-semibold text-text-secondary"
                    for="history-workflow-filter"
                >
                    <span>"Workflow"</span>
                    <select
                        id="history-workflow-filter"
                        name="history_workflow"
                        class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                    >
                        <option value="all" selected=(values.workflow == "all")>"All workflows"</option>
                        for definition in workflow_definitions() {
                            <option
                                value=(definition.workflow_id)
                                selected=(values.workflow == definition.workflow_id)
                            >
                                (definition.name)
                            </option>
                        }
                    </select>
                </label>
                <label
                    class="grid gap-1 text-sm font-semibold text-text-secondary"
                    for="history-trigger-filter"
                >
                    <span>"Trigger"</span>
                    <select
                        id="history-trigger-filter"
                        name="history_trigger"
                        class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                    >
                        <option value="all" selected=(values.trigger == "all")>"All triggers"</option>
                        <option value="manual" selected=(values.trigger == "manual")>"Manual"</option>
                        <option value="cron" selected=(values.trigger == "cron")>"Cron"</option>
                    </select>
                </label>
                <label
                    class="grid gap-1 text-sm font-semibold text-text-secondary"
                    for="history-status-filter"
                >
                    <span>"Status"</span>
                    <select
                        id="history-status-filter"
                        name="history_status"
                        class="min-h-[var(--control-min)] min-w-0 w-full rounded-control border border-border bg-canvas px-3 text-text-primary shadow-inset"
                    >
                        <option value="all" selected=(values.status == "all")>"All statuses"</option>
                        <option value="running" selected=(values.status == "running")>"Running"</option>
                        <option value="completed" selected=(values.status == "completed")>"Completed"</option>
                        <option value="failed" selected=(values.status == "failed")>"Failed"</option>
                    </select>
                </label>
                <div class="flex self-end gap-3">
                    <button
                        type="submit"
                        class="min-h-[var(--control-min)] rounded-control border border-accent-hover bg-accent px-4 font-semibold text-text-primary shadow-inset transition-[filter,transform] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110 active:translate-y-px"
                    >
                        "Search"
                    </button>
                    <a
                        class="inline-flex min-h-[var(--control-min)] items-center rounded-control border border-border px-4 font-semibold text-text-primary shadow-inset transition-[filter] duration-[var(--motion-micro)] ease-[var(--ease-standard)] hover:brightness-110"
                        href=(state.page_path.clone())
                    >
                        "Reset filters"
                    </a>
                </div>
            </form>
            <div
                class="max-w-full min-w-0 overflow-x-auto"
                tabindex="0"
                aria-label="Run history, horizontally scrollable"
            >
                <table class="w-full min-w-[var(--table-min)] border-collapse text-sm">
                    <thead>
                        <tr>
                            for heading in [
                                "Run ID",
                                "Workflow",
                                "Trigger",
                                "Input",
                                "Status",
                                "Route",
                                "Elapsed",
                            ] {
                                <th
                                    class="border-b border-border p-3 text-left align-top text-xs font-semibold text-text-muted"
                                    scope="col"
                                >
                                    (heading)
                                </th>
                            }
                        </tr>
                    </thead>
                    <tbody id="run-history-body">
                        if state.runs.is_empty() {
                            run_history_empty(filters_active: filters_active)
                        }
                        for run in state.runs {
                            run_history_row(run: run, filters: state.filters.clone())
                        }
                    </tbody>
                </table>
            </div>
        </section>
    }
}

#[component]
pub(super) async fn run_history_empty(filters_active: bool) -> Result {
    view! {
        <tr id="run-history-empty">
            <td class="border-b border-border p-3" colspan="7">
                if filters_active {
                    "No runs match the current history filters."
                } else {
                    "No runs yet. Select and start a code-defined workflow to inspect it here."
                }
            </td>
        </tr>
    }
}

#[component]
pub(super) async fn run_history_row(run: RunSnapshot, filters: HistoryFilters) -> Result {
    let run_id = run.run_id.to_string();
    let run_url = format!(
        "{}{}",
        workflow_url(&run.workflow_id, Some(&run_id)),
        filters.query_suffix()
    );
    view! {
        <tr
            id=(format!("run-history-{run_id}"))
            data-attr:aria-current=(format!("$selectedRunId === '{run_id}' ? 'true' : 'false'"))
            class="aria-[current=true]:bg-surface-elevated"
        >
            <td class="border-b border-border p-3 align-top">
                <a
                    class="font-mono text-[length:var(--type-code)] text-accent-hover underline"
                    href=(run_url)
                >
                    (run_id)
                </a>
            </td>
            <td class="border-b border-border p-3 align-top">(run.workflow_id.clone())</td>
            <td class="border-b border-border p-3 align-top">(trigger(&run))</td>
            <td class="border-b border-border p-3 align-top">(run.input.summary())</td>
            <td class="border-b border-border p-3 align-top">(run_status(&run))</td>
            <td class="border-b border-border p-3 align-top">(run.route_summary.clone())</td>
            <td class="border-b border-border p-3 align-top">(elapsed(&run))</td>
        </tr>
    }
}
