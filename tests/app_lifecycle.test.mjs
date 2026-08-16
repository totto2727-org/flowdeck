import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const response = (body) => ({ ok: true, status: 200, json: async () => body });

const element = () => ({
  attributes: {},
  dataset: {},
  hidden: false,
  disabled: false,
  textContent: "",
  listeners: {},
  addEventListener(type, listener) { this.listeners[type] = listener; },
  append() {},
  querySelector() { return null; },
  replaceChildren() {},
  setAttribute(name, value) { this.attributes[name] = value; },
});

const flush = () => new Promise(setImmediate);

test("stale polling cannot render or restart after a new run or pagehide", async () => {
  const runButton = element();
  const workflowOption = element();
  workflowOption.dataset.workflowId = "demo-workflow";
  const runForm = element();
  runForm.dataset.workflowId = "demo-workflow";
  const runLabel = element();
  runLabel.name = "label";
  runLabel.value = "manual browser run";
  const stepDelay = element();
  stepDelay.name = "step_delay_ms";
  stepDelay.dataset.jsonType = "number";
  stepDelay.value = "240";
  runForm.elements = [runLabel, stepDelay];
  runForm.querySelector = () => runButton;
  runForm.reset = () => {};
  const statusOutput = element();
  const triggerOutput = element();
  const inputOutput = element();
  const routeOutput = element();
  const elapsedOutput = element();
  const historyBody = element();
  const requestError = element();
  const topologyDescription = element();
  const topology = element();
  topology.dataset.topologyWorkflow = "demo-workflow";
  topologyDescription.parentElement = topology;
  const traceTitle = element();
  const traceStatus = element();
  const traceState = element();
  const traceOutput = element();
  const selectors = new Map([
    ['[data-testid="run-status"]', statusOutput],
    ["#workflow-summary", element()],
    ["#trigger-summary", triggerOutput],
    ["#input-summary", inputOutput],
    ['[data-testid="route-summary"]', routeOutput],
    ["#elapsed-summary", elapsedOutput],
    ["#run-history", historyBody],
    ["#request-error", requestError],
    ["#topology-desc", topologyDescription],
    ["#trace-title", traceTitle],
    ['[data-testid="trace-status"]', traceStatus],
    ['[data-testid="trace-state"]', traceState],
    ['[data-testid="trace-output"]', traceOutput],
    ["#trace-started", element()],
    ["#trace-finished", element()],
    ["#trace-duration", element()],
    ["#trace-edge", element()],
  ]);
  const document = {
    querySelector(selector) { return selectors.get(selector); },
    querySelectorAll(selector) {
      if (selector === "[data-workflow-option]") return [workflowOption];
      if (selector === "[data-workflow-run-form]") return [runForm];
      if (selector === "[data-topology-workflow]") return [topology];
      if (selector === "[data-topology-desc]") return [topologyDescription];
      return [];
    },
    createElement() { return element(); },
  };
  const pending = [];
  const fetch = (url, options) => {
    const request = deferred();
    pending.push({ ...request, url, ...options, signal: options.signal });
    return request.promise;
  };
  const timers = [];
  const window = {
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    clearTimeout(timer) { if (timer) timer.active = false; },
    setTimeout(callback) {
      const timer = { active: true, callback };
      timers.push(timer);
      return timer;
    },
  };
  const traceSource = await readFile(new URL("../src/app_trace.js", import.meta.url), "utf8");
  const renderSource = await readFile(new URL("../src/app_render.js", import.meta.url), "utf8");
  const lifecycleSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  vm.runInNewContext(`${traceSource}\n${renderSource}\n${lifecycleSource}`, { AbortController, Date, document, Error, fetch, window });

  assert.equal(pending.length, 1);
  const staleState = pending[0];
  const startPromise = runForm.listeners.submit({ preventDefault() {}, currentTarget: runForm });
  assert.equal(staleState.signal.aborted, true);
  assert.equal(pending.length, 2);
  assert.deepEqual(
    JSON.parse(pending[1].body),
    {
      workflow_id: "demo-workflow",
      input: { label: "manual browser run", step_delay_ms: 240 },
    },
  );

  pending[1].resolve(response({ outcome: "accepted", run: { run_id: "new-run" } }));
  await flush();
  assert.equal(pending.length, 3);
  staleState.resolve(response({ runs: [{ run_id: "old-run", status: "Completed" }] }));
  await flush();
  assert.equal(window.workflowState, undefined);

  const freshState = { workflows: [{
    workflow_id: "demo-workflow",
    name: "Branch and converge",
  }], runs: [{
    run_id: "new-run",
    workflow_id: "demo-workflow",
    input: { label: "manual browser run", step_delay_ms: 240 },
    input_summary: "manual browser run · 240 ms",
    trigger: "Manual",
    schedule_id: null,
    status: "Running",
    error: null,
    current_node: "choose_route",
    current_edge: "prepare-to-choose",
    traversed_nodes: ["prepare"],
    traversed_edges: ["prepare-to-choose"],
    route_summary: "prepare -> choose_route",
    elapsed_ms: 400,
    steps: [],
  }] };
  pending[2].resolve(response(freshState));
  await startPromise;
  assert.equal(window.workflowState, freshState);
  assert.equal(
    topologyDescription.textContent,
    "Running. Current node: choose_route. Current edge: prepare-to-choose. Traversed route: prepare.",
  );
  assert.equal(timers.filter((timer) => timer.active).length, 1);

  const timer = timers.find((candidate) => candidate.active);
  timer.active = false;
  timer.callback();
  assert.equal(pending.length, 4);
  window.listeners.pagehide();
  pending[3].resolve(response({ runs: [] }));
  await flush();
  assert.equal(window.workflowState, freshState);
  assert.equal(timers.filter((candidate) => candidate.active).length, 0);
});

test("graph selection renders the retained node trace", async () => {
  const node = element();
  node.dataset.nodeId = "choose_route";
  node.dataset.workflowId = "demo-workflow";
  const traceTitle = element();
  const traceStatus = element();
  const traceState = element();
  const traceOutput = element();
  const selectors = new Map([
    ["#trace-title", traceTitle],
    ["#workflow-summary", element()],
    ['[data-testid="trace-status"]', traceStatus],
    ['[data-testid="trace-state"]', traceState],
    ['[data-testid="trace-output"]', traceOutput],
  ]);
  const document = {
    querySelector(selector) { return selectors.get(selector) ?? element(); },
    querySelectorAll(selector) { return selector === "[data-node-id]" ? [node] : []; },
    createElement() { return element(); },
  };
  const window = {};
  const renderSource = await readFile(new URL("../src/app_render.js", import.meta.url), "utf8");
  const traceSource = await readFile(new URL("../src/app_trace.js", import.meta.url), "utf8");
  const context = vm.createContext({ document, window });
  vm.runInContext(`${traceSource}\n${renderSource}`, context);
  window.workflowState = { workflows: [{
    workflow_id: "demo-workflow",
    name: "Branch and converge",
  }], runs: [{
    run_id: "trace-run",
    workflow_id: "demo-workflow",
    input: { label: "inspect me", step_delay_ms: 240 },
    input_summary: "inspect me · 240 ms",
    trigger: "Manual",
    schedule_id: null,
    status: "Running",
    error: null,
    current_node: "choose_route",
    current_edge: "prepare-to-choose",
    traversed_nodes: ["prepare"],
    traversed_edges: ["prepare-to-choose"],
    route_summary: "prepare -> choose_route",
    elapsed_ms: 400,
    steps: [{
      sequence: 1,
      node_id: "choose_route",
      selected_edge: null,
      status: "Running",
      error: null,
      state: {
        input: { label: "inspect me", step_delay_ms: 240 },
        task_token: null,
        branch_selected: null,
        branch_token: null,
      },
      output: null,
      started_at_ms: 100,
      finished_at_ms: null,
      elapsed_ms: 300,
    }],
  }] };

  vm.runInContext("renderState(window.workflowState)", context);
  node.listeners.click();

  assert.equal(traceTitle.textContent, "Node · choose_route");
  assert.equal(traceStatus.textContent, "Running");
  assert.match(traceState.textContent, /\"label\": \"inspect me\"/);
  assert.equal(traceOutput.textContent, "Pending");
  assert.equal(node.attributes["aria-pressed"], "true");
});
