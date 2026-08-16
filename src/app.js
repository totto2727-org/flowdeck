"use strict";

let pollTimer = null;
let pollGeneration = 0;
let activeController = null;
let stopped = false;

const resetPolling = () => {
  pollGeneration += 1;
  window.clearTimeout(pollTimer);
  pollTimer = null;
  activeController?.abort();
  activeController = null;
  return pollGeneration;
};

const schedulePoll = (generation, delay) => {
  if (stopped || generation !== pollGeneration) {
    return;
  }
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    loadState(generation);
  }, delay);
};

const loadState = async (generation = pollGeneration) => {
  if (stopped || generation !== pollGeneration) {
    return;
  }
  const controller = new AbortController();
  activeController?.abort();
  activeController = controller;
  try {
    const response = await fetch("/api/state", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`State request failed with HTTP ${response.status}.`);
    }
    const state = await response.json();
    if (stopped || generation !== pollGeneration) {
      return;
    }
    setRequestError("");
    renderState(state);
    const running = state.runs.some((run) => run.status === "Running");
    schedulePoll(generation, running ? 120 : 1000);
  } catch (error) {
    if (stopped || generation !== pollGeneration || error?.name === "AbortError") {
      return;
    }
    statusOutput.textContent = "Request error";
    statusOutput.dataset.status = "error";
    setRequestError(error instanceof Error ? error.message : "Unable to load workflow state.");
    schedulePoll(generation, 1000);
  } finally {
    if (activeController === controller) {
      activeController = null;
    }
  }
};

const serializeWorkflowInput = (form) => Object.fromEntries(
  Array.from(form.elements)
    .filter((control) => control.name)
    .map((control) => [
      control.name,
      control.dataset.jsonType === "number" ? Number(control.value) : control.value,
    ]),
);

const startRun = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const runButton = form.querySelector("[data-run-workflow]");
  const generation = resetPolling();
  const controller = new AbortController();
  activeController = controller;
  runButton.disabled = true;
  statusOutput.textContent = "Loading";
  statusOutput.dataset.status = "loading";
  setRequestError("");
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        workflow_id: selectedWorkflowId,
        input: serializeWorkflowInput(form),
      }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok || result.outcome !== "accepted") {
      throw new Error(result.error || `Run request failed with HTTP ${response.status}.`);
    }
    if (stopped || generation !== pollGeneration) {
      return;
    }
    selectedRunId = result.run.run_id;
    activeController = null;
    await loadState(generation);
  } catch (error) {
    if (stopped || generation !== pollGeneration || error?.name === "AbortError") {
      return;
    }
    statusOutput.textContent = "Request error";
    statusOutput.dataset.status = "error";
    setRequestError(error instanceof Error ? error.message : "Unable to start the workflow.");
  } finally {
    if (activeController === controller) {
      activeController = null;
    }
    if (!stopped && generation === pollGeneration) {
      runButton.disabled = false;
    }
  }
};

for (const form of workflowForms) {
  form.addEventListener("submit", startRun);
}
window.addEventListener("pagehide", () => {
  stopped = true;
  resetPolling();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    stopped = false;
    loadState(resetPolling());
  }
});
loadState();
