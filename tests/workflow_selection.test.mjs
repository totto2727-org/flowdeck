import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const element = () => ({
  attributes: {}, dataset: {}, hidden: false, disabled: false, textContent: "", value: "",
  listeners: {},
  addEventListener(type, listener) { this.listeners[type] = listener; },
  append() {}, querySelector() { return null; }, replaceChildren() {},
  setAttribute(name, value) { this.attributes[name] = value; },
});

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const flush = () => new Promise(setImmediate);

test("selecting a workflow sends its ID and workflow-owned input defaults", async () => {
  const demo = element();
  demo.dataset.workflowId = "demo-workflow";
  const review = element();
  review.dataset.workflowId = "review-pipeline";
  const demoButton = element();
  const demoForm = element();
  demoForm.dataset.workflowId = "demo-workflow";
  demoForm.elements = [
    { dataset: {}, name: "label", value: "manual branch run" },
    { dataset: { jsonType: "number" }, name: "step_delay_ms", value: "350" },
  ];
  demoForm.querySelector = () => demoButton;
  demoForm.reset = () => {};
  const reviewButton = element();
  const reviewForm = element();
  reviewForm.dataset.workflowId = "review-pipeline";
  reviewForm.elements = [
    { dataset: {}, name: "subject", value: "release candidate" },
    { dataset: {}, name: "reviewer", value: "local operator" },
  ];
  reviewForm.querySelector = () => reviewButton;
  reviewForm.reset = () => {};
  const selectors = new Map([
    ['[data-testid="run-status"]', element()],
    ["#workflow-summary", element()],
    ["#trigger-summary", element()], ["#input-summary", element()],
    ['[data-testid="route-summary"]', element()], ["#elapsed-summary", element()],
    ["#run-history", element()], ["#request-error", element()],
    ["#trace-title", element()], ['[data-testid="trace-status"]', element()],
    ['[data-testid="trace-state"]', element()], ['[data-testid="trace-output"]', element()],
    ["#trace-started", element()], ["#trace-finished", element()],
    ["#trace-duration", element()], ["#trace-edge", element()],
  ]);
  const document = {
    querySelector(selector) { return selectors.get(selector); },
    querySelectorAll(selector) {
      if (selector === "[data-workflow-option]") return [demo, review];
      if (selector === "[data-workflow-run-form]") return [demoForm, reviewForm];
      return [];
    },
    createElement() { return element(); },
  };
  const requests = [];
  const state = {
    workflows: [
      { workflow_id: "demo-workflow", name: "Branch and converge" },
      { workflow_id: "review-pipeline", name: "Review pipeline" },
    ],
    runs: [],
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return options.method === "POST"
      ? response({ outcome: "accepted", run: { run_id: "review-run" } }, 201)
      : response(state);
  };
  const window = {
    addEventListener() {}, clearTimeout() {}, setTimeout() { return {}; },
  };
  const traceSource = await readFile(new URL("../src/app_trace.js", import.meta.url), "utf8");
  const renderSource = await readFile(new URL("../src/app_render.js", import.meta.url), "utf8");
  const lifecycleSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  vm.runInNewContext(`${traceSource}\n${renderSource}\n${lifecycleSource}`, {
    AbortController, Date, document, Error, fetch, window,
  });
  await flush();

  review.listeners.click();
  assert.equal(reviewForm.hidden, false);
  assert.equal(demoForm.hidden, true);
  await reviewForm.listeners.submit({ preventDefault() {}, currentTarget: reviewForm });

  const startRequest = requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(startRequest.body), {
    workflow_id: "review-pipeline",
    input: { subject: "release candidate", reviewer: "local operator" },
  });
  assert.equal(review.attributes["aria-pressed"], "true");
  assert.equal(demo.attributes["aria-pressed"], "false");
});
