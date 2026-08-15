use topcoat::{
    Result,
    asset::{Asset, asset},
    router::page,
    view::view,
};
use workflow_console_experiment::workflow_topology;

const APP_CSS: Asset = asset!("./app.css");
const APP_JS: Asset = asset!("./app.js");

#[page("/")]
async fn home() -> Result {
    let (nodes, edges) = workflow_topology();
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="description" content="Inspect and run the local code-defined workflow">
                <link rel="stylesheet" href=(APP_CSS)>
                <script src=(APP_JS) defer="defer"></script>
                <title>"Workflow Console"</title>
            </head>
            <body>
                <header class="topbar">
                    <div><p class="eyebrow">"Local operations"</p><h1>"Workflow Console"</h1></div>
                    <span class="environment">"In-memory"</span>
                </header>
                <main class="shell">
                    <aside class="workflow-rail" aria-labelledby="workflows-title">
                        <h2 id="workflows-title">"Workflows"</h2>
                        <article class="workflow-card">
                            <p class="eyebrow">"Code-defined"</p>
                            <h3>"Branch and converge"</h3>
                            <p class="muted">"Six fixed tasks with one conditional route."</p>
                            <code>"demo-workflow"</code>
                            <button type="button" data-testid="run-workflow" data-workflow-id="demo-workflow">"Run workflow"</button>
                        </article>
                    </aside>
                    <div class="inspection-stack">
                        <section class="panel inspector" aria-labelledby="inspector-title">
                            <div class="panel-heading">
                                <div><p class="eyebrow">"Selected run"</p><h2 id="inspector-title">"Execution route"</h2></div>
                                <p class="status-line" data-testid="run-status" role="status" aria-live="polite">"Loading"</p>
                            </div>
                            <dl class="summary-grid">
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
                                <svg class="topology" viewBox="0 0 760 300" role="img" aria-labelledby="topology-title topology-desc">
                                    <title id="topology-title">"Branch and converge workflow topology"</title>
                                    <desc id="topology-desc">"Prepare flows to route selection, branches to yes or fallback, then converges and completes."</desc>
                                    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>
                                    for edge in edges {
                                        <g data-edge-id=(edge.id) data-state="idle" role="group" aria-label=(format!("{} to {}", edge.from, edge.to))>
                                            <path class="edge" d=(edge_path(edge.id)) marker-end="url(#arrow)"></path>
                                            <text class="edge-state" x=(edge_label_x(edge.id)) y=(edge_label_y(edge.id))>"Idle"</text>
                                        </g>
                                    }
                                    for node in nodes {
                                        <g data-node-id=(node.id) data-state="idle" role="group" transform=(node_transform(node.id)) aria-label=(node.label)>
                                            <rect class="node" width="120" height="54" rx="6"></rect>
                                            <text class="node-label" x="60" y="23" text-anchor="middle">(node.label)</text>
                                            <text class="node-state" x="60" y="41" text-anchor="middle">"Idle"</text>
                                        </g>
                                    }
                                </svg>
                            </div>
                        </section>
                        <section class="panel" aria-labelledby="history-title">
                            <div class="panel-heading"><div><p class="eyebrow">"Process lifetime"</p><h2 id="history-title">"Run history"</h2></div></div>
                            <div class="history-scroll" tabindex="0" aria-label="Run history, horizontally scrollable">
                                <table>
                                    <thead><tr><th scope="col">"Run ID"</th><th scope="col">"Status"</th><th scope="col">"Route"</th><th scope="col">"Elapsed"</th></tr></thead>
                                    <tbody id="run-history"><tr id="empty-history"><td colspan="4">"No runs yet. Start the code-defined workflow to inspect it here."</td></tr></tbody>
                                </table>
                            </div>
                        </section>
                    </div>
                </main>
            </body>
        </html>
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
        _ => "M 0 0",
    }
}

fn edge_label_x(id: &str) -> &'static str {
    match id {
        "prepare-to-choose" => "142",
        "choose-to-yes" | "choose-to-fallback" => "294",
        "yes-to-converge" | "fallback-to-converge" => "452",
        "converge-to-complete" => "612",
        _ => "0",
    }
}

fn edge_label_y(id: &str) -> &'static str {
    match id {
        "choose-to-yes" | "yes-to-converge" => "94",
        "choose-to-fallback" | "fallback-to-converge" => "218",
        "prepare-to-choose" | "converge-to-complete" => "173",
        _ => "0",
    }
}
