"use strict";

const runButton = document.querySelector('[data-testid="run-workflow"]');
const runForm = document.querySelector('[data-testid="run-form"]');
const runLabelInput = document.querySelector('[data-testid="run-label"]');
const stepDelayInput = document.querySelector('[data-testid="step-delay"]');
const statusOutput = document.querySelector('[data-testid="run-status"]');
const triggerOutput = document.querySelector("#trigger-summary");
const workflowOutput = document.querySelector("#workflow-summary");
const inputOutput = document.querySelector("#input-summary");
const routeOutput = document.querySelector('[data-testid="route-summary"]');
const elapsedOutput = document.querySelector("#elapsed-summary");
const historyBody = document.querySelector("#run-history");
const requestError = document.querySelector("#request-error");
const runFormTitle = document.querySelector("#run-form-title");
const workflowOptions = [...document.querySelectorAll("[data-workflow-option]")];
const topologies = [...document.querySelectorAll("[data-topology-workflow]")];
const topologyDescriptions = [...document.querySelectorAll("[data-topology-desc]")];

let selectedRunId;
let selectedWorkflowId = workflowOptions[0]?.dataset.workflowId || null;

const setRequestError = (message) => {
  requestError.textContent = message;
  requestError.hidden = message.length === 0;
};

const formatElapsed = (milliseconds) => {
  if (milliseconds < 1000) {
    return `${milliseconds} ms`;
  }
  return `${(milliseconds / 1000).toFixed(1)} s`;
};

const formatTrigger = (run) => run.trigger === "Cron"
  ? `Cron · ${run.schedule_id}`
  : "Manual";

const formatInput = (run) => `${run.input.label} · ${run.input.step_delay_ms} ms`;

const setGraphState = (element, state) => {
  element.dataset.state = state;
  const label = element.querySelector(".node-state, .edge-state");
  if (label) {
    label.textContent = state[0].toUpperCase() + state.slice(1);
  }
};

const setGraphSelection = (element, kind, id) => {
  const selected = selectedTraceTarget?.workflowId === element.dataset.workflowId
    && selectedTraceTarget.kind === kind && selectedTraceTarget.id === id;
  element.dataset.selected = String(selected);
  element.setAttribute("aria-pressed", String(selected));
};

const renderTopology = (run) => {
  const workflowId = run?.workflow_id || selectedWorkflowId;
  const running = run?.status === "Running";
  const traversedRoute = run?.traversed_nodes.length ? run.traversed_nodes.join(" to ") : "none";
  const description = !run
    ? "No run selected. All workflow nodes and edges are idle."
    : running
      ? `Running. Current node: ${run.current_node || "none"}. Current edge: ${run.current_edge || "none"}. Traversed route: ${traversedRoute}.`
      : `${run.status}. Traversed route: ${traversedRoute}.`;
  for (const topology of topologies) {
    topology.dataset.active = String(topology.dataset.topologyWorkflow === workflowId);
  }
  for (const topologyDescription of topologyDescriptions) {
    if (topologyDescription.parentElement?.dataset.topologyWorkflow === workflowId) {
      topologyDescription.textContent = description;
    }
  }
  for (const element of nodeElements) {
    const id = element.dataset.nodeId;
    const isCurrentWorkflow = element.dataset.workflowId === workflowId;
    const state = isCurrentWorkflow && running && id === run.current_node
      ? "active"
      : isCurrentWorkflow && run?.traversed_nodes.includes(id) ? "traversed" : "idle";
    setGraphState(element, state);
    setGraphSelection(element, "node", id);
  }
  for (const element of edgeElements) {
    const id = element.dataset.edgeId;
    const isCurrentWorkflow = element.dataset.workflowId === workflowId;
    const state = isCurrentWorkflow && running && id === run.current_edge
      ? "active"
      : isCurrentWorkflow && run?.traversed_edges.includes(id) ? "traversed" : "idle";
    setGraphState(element, state);
    setGraphSelection(element, "edge", id);
  }
};

const workflowById = (state, workflowId) => state.workflows
  .find((workflow) => workflow.workflow_id === workflowId);

const applyWorkflowSelection = (state, resetInputs) => {
  const workflow = workflowById(state, selectedWorkflowId);
  for (const option of workflowOptions) {
    option.setAttribute("aria-pressed", String(option.dataset.workflowId === selectedWorkflowId));
  }
  if (!workflow) {
    runButton.disabled = true;
    return;
  }
  runButton.disabled = false;
  runFormTitle.textContent = workflow.name || workflow.workflow_id;
  if (resetInputs) {
    runLabelInput.value = workflow.input.default_label;
    stepDelayInput.value = String(workflow.input.default_step_delay_ms);
    stepDelayInput.setAttribute("min", String(workflow.input.min_step_delay_ms));
    stepDelayInput.setAttribute("max", String(workflow.input.max_step_delay_ms));
  }
};

const renderSelectedRun = (run) => {
  if (!run) {
    statusOutput.textContent = "Empty";
    statusOutput.dataset.status = "empty";
    routeOutput.textContent = "No run selected";
    workflowOutput.textContent = selectedWorkflowId || "—";
    triggerOutput.textContent = "—";
    inputOutput.textContent = "—";
    elapsedOutput.textContent = "—";
    setRequestError("");
    synchronizeTraceSelection(null);
    renderTopology(null);
    renderTrace(null);
    return;
  }
  statusOutput.textContent = run.status;
  statusOutput.dataset.status = run.status.toLowerCase();
  routeOutput.textContent = run.route_summary || "Route not available";
  workflowOutput.textContent = run.workflow_id;
  triggerOutput.textContent = formatTrigger(run);
  inputOutput.textContent = formatInput(run);
  elapsedOutput.textContent = formatElapsed(run.elapsed_ms);
  setRequestError(run.status === "Failed" ? run.error || "The workflow failed without an error message." : "");
  synchronizeTraceSelection(run);
  renderTopology(run);
  renderTrace(run);
};

const historyCell = (text) => {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
};

const historyButton = (run) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-select";
  button.textContent = run.run_id;
  button.dataset.runId = run.run_id;
  if (run.run_id === selectedRunId) {
    button.setAttribute("aria-current", "true");
  }
  button.addEventListener("click", () => {
    selectedRunId = run.run_id;
    renderState(window.workflowState);
  });
  return button;
};

const renderHistory = (runs) => {
  historyBody.replaceChildren();
  if (runs.length === 0) {
    const row = document.createElement("tr");
    const cell = historyCell("No runs yet. Start the code-defined workflow to inspect it here.");
    cell.colSpan = 7;
    row.append(cell);
    historyBody.append(row);
    return;
  }
  for (const run of runs) {
    const row = document.createElement("tr");
    row.dataset.selected = String(run.run_id === selectedRunId);
    const idCell = document.createElement("td");
    idCell.append(historyButton(run));
    const statusCell = historyCell(run.status);
    statusCell.dataset.status = run.status.toLowerCase();
    row.append(
      idCell,
      historyCell(run.workflow_id),
      historyCell(formatTrigger(run)),
      historyCell(formatInput(run)),
      statusCell,
      historyCell(run.route_summary),
      historyCell(formatElapsed(run.elapsed_ms)),
    );
    historyBody.append(row);
  }
};

const renderState = (state) => {
  window.workflowState = state;
  if (!workflowById(state, selectedWorkflowId)) {
    selectedWorkflowId = state.workflows[0]?.workflow_id || null;
  }
  applyWorkflowSelection(state, false);
  if (selectedRunId && !state.runs.some((run) => run.run_id === selectedRunId)) {
    selectedRunId = undefined;
  }
  if (selectedRunId === undefined) {
    selectedRunId = state.runs[0]?.run_id || null;
  }
  renderHistory(state.runs);
  renderSelectedRun(state.runs.find((run) => run.run_id === selectedRunId));
};

for (const option of workflowOptions) {
  option.addEventListener("click", () => {
    selectedWorkflowId = option.dataset.workflowId;
    selectedRunId = null;
    applyWorkflowSelection(window.workflowState, true);
    renderState(window.workflowState);
  });
}
