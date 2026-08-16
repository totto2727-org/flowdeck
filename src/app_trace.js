"use strict";

const traceTitle = document.querySelector("#trace-title");
const traceStatus = document.querySelector('[data-testid="trace-status"]');
const traceState = document.querySelector('[data-testid="trace-state"]');
const traceOutput = document.querySelector('[data-testid="trace-output"]');
const traceStarted = document.querySelector("#trace-started");
const traceFinished = document.querySelector("#trace-finished");
const traceDuration = document.querySelector("#trace-duration");
const traceEdge = document.querySelector("#trace-edge");
const nodeElements = [...document.querySelectorAll("[data-node-id]")];
const edgeElements = [...document.querySelectorAll("[data-edge-id]")];

let selectedTraceTarget = null;
let selectedTraceRunId = null;

const formatTimestamp = (milliseconds) => milliseconds
  ? new Date(milliseconds).toISOString()
  : "—";

const traceForTarget = (run) => {
  if (!run || !selectedTraceTarget) {
    return null;
  }
  return [...run.steps].reverse().find((step) => selectedTraceTarget.kind === "node"
    ? step.node_id === selectedTraceTarget.id
    : step.selected_edge === selectedTraceTarget.id) || null;
};

const synchronizeTraceSelection = (run) => {
  if (!run) {
    selectedTraceRunId = null;
    selectedTraceTarget = null;
    return;
  }
  if (selectedTraceRunId !== run.run_id) {
    selectedTraceRunId = run.run_id;
    const current = [...run.steps].reverse().find((step) => step.node_id === run.current_node);
    const latest = current || run.steps.at(-1);
    selectedTraceTarget = latest
      ? { kind: "node", id: latest.node_id, workflowId: run.workflow_id }
      : null;
  }
};

const renderTrace = (run) => {
  const trace = traceForTarget(run);
  const targetLabel = selectedTraceTarget
    ? `${selectedTraceTarget.kind === "node" ? "Node" : "Edge"} · ${selectedTraceTarget.id}`
    : "No graph item selected";
  traceTitle.textContent = targetLabel;
  traceStatus.textContent = trace?.status || "Not executed";
  traceStatus.dataset.status = trace?.status?.toLowerCase() || "idle";
  traceState.textContent = trace ? JSON.stringify(trace.state, null, 2) : "No state captured";
  traceOutput.textContent = trace?.error ? `Error: ${trace.error}` : trace?.output || (trace ? "Pending" : "No output captured");
  traceStarted.textContent = formatTimestamp(trace?.started_at_ms);
  traceFinished.textContent = formatTimestamp(trace?.finished_at_ms);
  traceDuration.textContent = trace ? formatElapsed(trace.elapsed_ms) : "—";
  traceEdge.textContent = trace?.selected_edge || "—";
};

const selectTraceTarget = (kind, id) => {
  selectedTraceRunId = selectedRunId;
  const run = window.workflowState?.runs.find((candidate) => candidate.run_id === selectedRunId);
  selectedTraceTarget = { kind, id, workflowId: run?.workflow_id || selectedWorkflowId };
  renderState(window.workflowState);
};

const bindTraceTarget = (element, kind, id) => {
  element.addEventListener("click", () => selectTraceTarget(kind, id));
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectTraceTarget(kind, id);
    }
  });
};

for (const element of nodeElements) {
  bindTraceTarget(element, "node", element.dataset.nodeId);
}
for (const element of edgeElements) {
  bindTraceTarget(element, "edge", element.dataset.edgeId);
}
