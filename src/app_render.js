"use strict";

const runButton = document.querySelector('[data-testid="run-workflow"]');
const runForm = document.querySelector('[data-testid="run-form"]');
const runLabelInput = document.querySelector('[data-testid="run-label"]');
const stepDelayInput = document.querySelector('[data-testid="step-delay"]');
const statusOutput = document.querySelector('[data-testid="run-status"]');
const triggerOutput = document.querySelector("#trigger-summary");
const inputOutput = document.querySelector("#input-summary");
const routeOutput = document.querySelector('[data-testid="route-summary"]');
const elapsedOutput = document.querySelector("#elapsed-summary");
const historyBody = document.querySelector("#run-history");
const requestError = document.querySelector("#request-error");
const topologyDescription = document.querySelector("#topology-desc");
const nodeElements = [...document.querySelectorAll("[data-node-id]")];
const edgeElements = [...document.querySelectorAll("[data-edge-id]")];

let selectedRunId = null;

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

const renderTopology = (run) => {
  const running = run?.status === "Running";
  const traversedRoute = run?.traversed_nodes.length ? run.traversed_nodes.join(" to ") : "none";
  topologyDescription.textContent = !run
    ? "No run selected. All workflow nodes and edges are idle."
    : running
      ? `Running. Current node: ${run.current_node || "none"}. Current edge: ${run.current_edge || "none"}. Traversed route: ${traversedRoute}.`
      : `${run.status}. Traversed route: ${traversedRoute}.`;
  for (const element of nodeElements) {
    const id = element.dataset.nodeId;
    const state = running && id === run.current_node
      ? "active"
      : run?.traversed_nodes.includes(id) ? "traversed" : "idle";
    setGraphState(element, state);
  }
  for (const element of edgeElements) {
    const id = element.dataset.edgeId;
    const state = running && id === run.current_edge
      ? "active"
      : run?.traversed_edges.includes(id) ? "traversed" : "idle";
    setGraphState(element, state);
  }
};

const renderSelectedRun = (run) => {
  if (!run) {
    statusOutput.textContent = "Empty";
    statusOutput.dataset.status = "empty";
    routeOutput.textContent = "No run selected";
    triggerOutput.textContent = "—";
    inputOutput.textContent = "—";
    elapsedOutput.textContent = "—";
    setRequestError("");
    renderTopology(null);
    return;
  }
  statusOutput.textContent = run.status;
  statusOutput.dataset.status = run.status.toLowerCase();
  routeOutput.textContent = run.route_summary || "Route not available";
  triggerOutput.textContent = formatTrigger(run);
  inputOutput.textContent = formatInput(run);
  elapsedOutput.textContent = formatElapsed(run.elapsed_ms);
  setRequestError(run.status === "Failed" ? run.error || "The workflow failed without an error message." : "");
  renderTopology(run);
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
    cell.colSpan = 6;
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
  if (selectedRunId && !state.runs.some((run) => run.run_id === selectedRunId)) {
    selectedRunId = null;
  }
  selectedRunId ||= state.runs[0]?.run_id || null;
  renderHistory(state.runs);
  renderSelectedRun(state.runs.find((run) => run.run_id === selectedRunId));
};
