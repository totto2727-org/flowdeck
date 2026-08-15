"use strict";

const runButton = document.querySelector('[data-testid="run-workflow"]');
const statusOutput = document.querySelector('[data-testid="run-status"]');
const routeOutput = document.querySelector('[data-testid="route-summary"]');
const elapsedOutput = document.querySelector("#elapsed-summary");
const historyBody = document.querySelector("#run-history");
const requestError = document.querySelector("#request-error");
const nodeElements = [...document.querySelectorAll("[data-node-id]")];
const edgeElements = [...document.querySelectorAll("[data-edge-id]")];

let selectedRunId = null;
let pollTimer = null;

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

const setGraphState = (element, state) => {
  element.dataset.state = state;
  const label = element.querySelector(".node-state, .edge-state");
  if (label) {
    label.textContent = state[0].toUpperCase() + state.slice(1);
  }
};

const renderTopology = (run) => {
  const running = run?.status === "Running";
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
    elapsedOutput.textContent = "—";
    setRequestError("");
    renderTopology(null);
    return;
  }
  statusOutput.textContent = run.status;
  statusOutput.dataset.status = run.status.toLowerCase();
  routeOutput.textContent = run.route_summary || "Route not available";
  elapsedOutput.textContent = formatElapsed(run.elapsed_ms);
  setRequestError(run.status === "Failed" ? run.error || "The workflow failed without an error message." : "");
  renderTopology(run);
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

const historyCell = (text) => {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
};

const renderHistory = (runs) => {
  historyBody.replaceChildren();
  if (runs.length === 0) {
    const row = document.createElement("tr");
    const cell = historyCell("No runs yet. Start the code-defined workflow to inspect it here.");
    cell.colSpan = 4;
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
    row.append(idCell, statusCell, historyCell(run.route_summary), historyCell(formatElapsed(run.elapsed_ms)));
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

const loadState = async () => {
  try {
    const response = await fetch("/api/state", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`State request failed with HTTP ${response.status}.`);
    }
    const state = await response.json();
    setRequestError("");
    renderState(state);
    const running = state.runs.some((run) => run.status === "Running");
    pollTimer = window.setTimeout(loadState, running ? 120 : 1000);
  } catch (error) {
    statusOutput.textContent = "Request error";
    statusOutput.dataset.status = "error";
    setRequestError(error instanceof Error ? error.message : "Unable to load workflow state.");
    pollTimer = window.setTimeout(loadState, 1000);
  }
};

const startRun = async (event) => {
  event.preventDefault();
  window.clearTimeout(pollTimer);
  runButton.disabled = true;
  statusOutput.textContent = "Loading";
  statusOutput.dataset.status = "loading";
  setRequestError("");
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ workflow_id: runButton.dataset.workflowId }),
    });
    const result = await response.json();
    if (!response.ok || result.outcome !== "accepted") {
      throw new Error(result.error || `Run request failed with HTTP ${response.status}.`);
    }
    selectedRunId = result.run.run_id;
    await loadState();
  } catch (error) {
    statusOutput.textContent = "Request error";
    statusOutput.dataset.status = "error";
    setRequestError(error instanceof Error ? error.message : "Unable to start the workflow.");
  } finally {
    runButton.disabled = false;
  }
};

runButton.addEventListener("click", startRun);
window.addEventListener("pagehide", () => window.clearTimeout(pollTimer));
loadState();
