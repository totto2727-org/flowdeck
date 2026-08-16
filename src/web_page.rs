use topcoat::{
    Result,
    asset::{Asset, asset},
    router::page,
    view::{component, view},
};
use workflow_console_experiment::{
    workflow_definitions, workflow_id, workflow_input_form, workflow_schedules,
};

const APP_CSS: Asset = asset!("./app.css");
const APP_TRACE_JS: Asset = asset!("./app_trace.js");
const APP_RENDER_JS: Asset = asset!("./app_render.js");
const APP_JS: Asset = asset!("./app.js");

#[page("/")]
async fn home() -> Result {
    let definitions = workflow_definitions();
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="description" content="Inspect and run the local code-defined workflow">
                <link rel="stylesheet" href=(APP_CSS)>
                <script src=(APP_TRACE_JS) defer="defer"></script>
                <script src=(APP_RENDER_JS) defer="defer"></script>
                <script src=(APP_JS) defer="defer"></script>
                <title>"Workflow Console"</title>
            </head>
            <body>
                <header class="topbar">
                    <div><p class="eyebrow">"Local operations"</p><h1>"Workflow Console"</h1></div>
                    <span class="environment">"In-memory"</span>
                </header>
                <main class="shell">
                    workflow_rail()
                    <div class="inspection-stack">
                        <section class="panel inspector" aria-labelledby="inspector-title">
                            <div class="panel-heading">
                                <div><p class="eyebrow">"Selected run"</p><h2 id="inspector-title">"Execution route"</h2></div>
                                <p class="status-line" data-testid="run-status" role="status" aria-live="polite">"Loading"</p>
                            </div>
                            <dl class="summary-grid">
                                <div><dt>"Workflow"</dt><dd id="workflow-summary">"—"</dd></div>
                                <div><dt>"Trigger"</dt><dd id="trigger-summary">"—"</dd></div>
                                <div><dt>"Input"</dt><dd id="input-summary">"—"</dd></div>
                                <div><dt>"Route"</dt><dd data-testid="route-summary">"Waiting for state"</dd></div>
                                <div><dt>"Elapsed"</dt><dd id="elapsed-summary">"—"</dd></div>
                            </dl>
                            <p id="request-error" class="request-error" role="alert" hidden="hidden"></p>
                            <div class="legend" aria-label="Topology state legend">
                                <span><i data-legend="idle"></i>"Idle"</span>
                                <span><i data-legend="active"></i>"Active"</span>
                                <span><i data-legend="traversed"></i>"Traversed"</span>
                            </div>
                            <div class="topology-scroll" tabindex="0" aria-label="Workflow topology, horizontally scrollable">
                                for definition in definitions {
                                    <svg class="topology" data-topology-workflow=(definition.workflow_id) data-active=(if definition.workflow_id == workflow_id() { "true" } else { "false" }) viewBox="0 0 760 300" role="group" aria-labelledby=(format!("topology-title-{} topology-desc-{}", definition.workflow_id, definition.workflow_id))>
                                        <title id=(format!("topology-title-{}", definition.workflow_id))>(format!("{} workflow topology", definition.name))</title>
                                        <desc id=(format!("topology-desc-{}", definition.workflow_id)) data-topology-desc="">(definition.description)</desc>
                                        <defs><marker id=(format!("arrow-{}", definition.workflow_id)) viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>
                                        for edge in definition.edges {
                                            <g class="graph-target" data-edge-id=(edge.id) data-workflow-id=(definition.workflow_id) data-state="idle" data-selected="false" tabindex="0" role="button" aria-pressed="false" aria-label=(format!("Inspect edge from {} to {}", edge.from, edge.to))>
                                                <path class="edge-hit" d=(edge_path(edge.id))></path>
                                                <path class="edge" d=(edge_path(edge.id)) marker-end=(format!("url(#arrow-{})", definition.workflow_id))></path>
                                                <text class="edge-state" x=(edge_label_x(edge.id)) y=(edge_label_y(edge.id))>"Idle"</text>
                                            </g>
                                        }
                                        for node in definition.nodes {
                                            <g class="graph-target" data-node-id=(node.id) data-workflow-id=(definition.workflow_id) data-state="idle" data-selected="false" tabindex="0" role="button" transform=(node_transform(node.id)) aria-pressed="false" aria-label=(format!("Inspect {} node", node.label))>
                                                <rect class="node" width="120" height="54" rx="6"></rect>
                                                <text class="node-label" x="60" y="23" text-anchor="middle">(node.label)</text>
                                                <text class="node-state" x="60" y="41" text-anchor="middle">"Idle"</text>
                                            </g>
                                        }
                                    </svg>
                                }
                            </div>
                            trace_detail()
                        </section>
                        <section class="panel" aria-labelledby="history-title">
                            <div class="panel-heading"><div><p class="eyebrow">"Process lifetime"</p><h2 id="history-title">"Run history"</h2></div></div>
                            <div class="history-scroll" tabindex="0" aria-label="Run history, horizontally scrollable">
                                <table>
                                    <thead><tr><th scope="col">"Run ID"</th><th scope="col">"Workflow"</th><th scope="col">"Trigger"</th><th scope="col">"Input"</th><th scope="col">"Status"</th><th scope="col">"Route"</th><th scope="col">"Elapsed"</th></tr></thead>
                                    <tbody id="run-history"><tr id="empty-history"><td colspan="7">"No runs yet. Select and start a code-defined workflow to inspect it here."</td></tr></tbody>
                                </table>
                            </div>
                        </section>
                    </div>
                </main>
            </body>
        </html>
    }
}

#[component]
async fn workflow_rail() -> Result {
    let definitions = workflow_definitions();
    let schedules = workflow_schedules();
    view! {
        <aside class="workflow-rail" aria-labelledby="workflows-title">
            <h2 id="workflows-title">"Workflows"</h2>
            <div class="workflow-options" role="group" aria-label="Code-defined workflows">
                for definition in definitions {
                    <button type="button" class="workflow-card workflow-option" data-workflow-option="" data-workflow-id=(definition.workflow_id) aria-pressed=(if definition.workflow_id == workflow_id() { "true" } else { "false" })>
                        <span class="eyebrow">"Code-defined"</span>
                        <strong>(definition.name)</strong>
                        <span class="muted">(definition.description)</span>
                        <code>(definition.workflow_id)</code>
                        for schedule in schedules.iter().filter(|schedule| schedule.workflow_id == definition.workflow_id) {
                            <span class="schedule-summary"><span class="eyebrow">"Cron schedule"</span><code>(schedule.cron_expression)</code><span class="muted">(schedule.input_summary)</span></span>
                        }
                    </button>
                }
            </div>
            for definition in definitions {
                workflow_input_form(
                    workflow_id: definition.workflow_id,
                    active: definition.workflow_id == workflow_id(),
                )
            }
        </aside>
    }
}

#[component]
async fn trace_detail() -> Result {
    view! {
        <section class="trace-detail" aria-labelledby="trace-title">
            <div class="trace-heading"><div><p class="eyebrow">"Step trace"</p><h3 id="trace-title">"No graph item selected"</h3></div><span class="trace-status" data-testid="trace-status">"Unavailable"</span></div>
            <dl class="trace-meta">
                <div><dt>"Started"</dt><dd id="trace-started">"—"</dd></div>
                <div><dt>"Finished"</dt><dd id="trace-finished">"—"</dd></div>
                <div><dt>"Duration"</dt><dd id="trace-duration">"—"</dd></div>
                <div><dt>"Selected edge"</dt><dd id="trace-edge">"—"</dd></div>
            </dl>
            <div class="trace-data"><div><p class="eyebrow">"State after node"</p><pre data-testid="trace-state">"No state captured"</pre></div><div><p class="eyebrow">"Output / error"</p><pre data-testid="trace-output">"No output captured"</pre></div></div>
        </section>
    }
}

fn node_transform(id: &str) -> &'static str {
    match id {
        "prepare" => "translate(20 123)",
        "choose_route" => "translate(170 123)",
        "yes_path" => "translate(330 42)",
        "fallback_path" => "translate(330 204)",
        "converge" => "translate(490 123)",
        "complete" => "translate(640 123)",
        "receive" => "translate(50 123)",
        "inspect" => "translate(230 123)",
        "approve" => "translate(410 123)",
        "archive" => "translate(590 123)",
        _ => "translate(0 0)",
    }
}

fn edge_path(id: &str) -> &'static str {
    match id {
        "prepare-to-choose" => "M 140 150 L 170 150",
        "choose-to-yes" => "M 290 144 C 305 144 305 69 330 69",
        "choose-to-fallback" => "M 290 156 C 305 156 305 231 330 231",
        "yes-to-converge" => "M 450 69 C 475 69 475 144 490 144",
        "fallback-to-converge" => "M 450 231 C 475 231 475 156 490 156",
        "converge-to-complete" => "M 610 150 L 640 150",
        "receive-to-inspect" => "M 170 150 L 230 150",
        "inspect-to-approve" => "M 350 150 L 410 150",
        "approve-to-archive" => "M 530 150 L 590 150",
        _ => "M 0 0",
    }
}

fn edge_label_x(id: &str) -> &'static str {
    match id {
        "prepare-to-choose" => "142",
        "choose-to-yes" | "choose-to-fallback" => "294",
        "yes-to-converge" | "fallback-to-converge" => "452",
        "converge-to-complete" => "612",
        "receive-to-inspect" => "180",
        "inspect-to-approve" => "360",
        "approve-to-archive" => "540",
        _ => "0",
    }
}

fn edge_label_y(id: &str) -> &'static str {
    match id {
        "choose-to-yes" | "yes-to-converge" => "94",
        "choose-to-fallback" | "fallback-to-converge" => "218",
        "prepare-to-choose"
        | "converge-to-complete"
        | "receive-to-inspect"
        | "inspect-to-approve"
        | "approve-to-archive" => "173",
        _ => "0",
    }
}
