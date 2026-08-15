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
  dataset: {},
  hidden: false,
  disabled: false,
  textContent: "",
  listeners: {},
  addEventListener(type, listener) { this.listeners[type] = listener; },
  append() {},
  querySelector() { return null; },
  replaceChildren() {},
  setAttribute() {},
});

const flush = () => new Promise(setImmediate);

test("stale polling cannot render or restart after a new run or pagehide", async () => {
  const runButton = element();
  runButton.dataset.workflowId = "demo-workflow";
  const runForm = element();
  const runLabel = element();
  runLabel.value = "manual browser run";
  const stepDelay = element();
  stepDelay.value = "240";
  const statusOutput = element();
  const triggerOutput = element();
  const inputOutput = element();
  const routeOutput = element();
  const elapsedOutput = element();
  const historyBody = element();
  const requestError = element();
  const topologyDescription = element();
  const selectors = new Map([
    ['[data-testid="run-workflow"]', runButton],
    ['[data-testid="run-form"]', runForm],
    ['[data-testid="run-label"]', runLabel],
    ['[data-testid="step-delay"]', stepDelay],
    ['[data-testid="run-status"]', statusOutput],
    ["#trigger-summary", triggerOutput],
    ["#input-summary", inputOutput],
    ['[data-testid="route-summary"]', routeOutput],
    ["#elapsed-summary", elapsedOutput],
    ["#run-history", historyBody],
    ["#request-error", requestError],
    ["#topology-desc", topologyDescription],
  ]);
  const document = {
    querySelector(selector) { return selectors.get(selector); },
    querySelectorAll() { return []; },
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
  const renderSource = await readFile(new URL("../src/app_render.js", import.meta.url), "utf8");
  const lifecycleSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  vm.runInNewContext(`${renderSource}\n${lifecycleSource}`, { AbortController, document, Error, fetch, window });

  assert.equal(pending.length, 1);
  const staleState = pending[0];
  const startPromise = runForm.listeners.submit({ preventDefault() {} });
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

  const freshState = { runs: [{
    run_id: "new-run",
    input: { label: "manual browser run", step_delay_ms: 240 },
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
