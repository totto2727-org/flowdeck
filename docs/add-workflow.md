# Add a workflow

Use this checklist to add an installed workflow without changing core.
See [architecture](architecture.md) for ownership and [workflow graphs](workflow-graphs.md) for execution contracts.

## Add the workflow-owned files

- [ ] Create `src/user-land/workflow/<name>/definition.ts` for the lightweight Worker resource identity.
- [ ] Add `feature/input.ts` with the workflow ID, supported semantic versions, and input schemas.
- [ ] Add versioned native Machine definitions under `feature/`.
- [ ] Keep prompts, node names, transitions, recovery decisions, status projection, and boundary events in the workflow.
- [ ] Add the catalog definition and `prepare` operation under `feature/`.
- [ ] Validate workflow-specific input before allocating a run ID, persisting state, or dispatching execution.
- [ ] Add `worker.ts` with one workflow Worker and one logical Durable Object ID per run.
- [ ] Compose complete runtime Layers at the Worker and Durable Object roots.
- [ ] Use the existing managed persistence host and Store contracts for committed snapshots and ACK ordering.

For a Pi workflow, use `PiSandbox` and the shared node operations from `src/core/feature/pi/`.
Use `PiSdk`, `makePiSdk`, `PiRun`, and `PiContainer` from `src/core/worker/pi/` when assembling its runtime.
Keep native SDK clients and Workspace capabilities inside the run Durable Object.
Do not add workflow node names, prompts, or completion policy to shared Pi operations.

## Register the installed Worker

- [ ] Add a static Worker binding and typed RPC adapter in `src/bridge/workflow/user-land/feature/environment.ts`.
- [ ] Add its Context service in `src/bridge/workflow/user-land/feature/workflow-binding.ts`.
- [ ] Register the workflow definition and execution binding in `src/bridge/workflow/user-land/feature/registration.ts`.
- [ ] Add the Worker implementation Layer to `src/user-land/application.ts` in dependency order.
- [ ] Add the resource to `src/user-land/resources.ts`.
- [ ] Keep `alchemy.ts` a thin re-export of that resource list.

Do not edit `src/core/`, `src/share/`, or `src/bridge/workflow/core/` to register a workflow.
Do not add a Control binding or a frontend branch for its workflow ID.
The existing `src/bridge/workflow/bridge/worker.ts` entry composes the registered environment and runtime.

## Verify the addition

- [ ] Add workflow-owned tests beside its features.
- [ ] Put tests that combine core and concrete workflows under `tests/integration/`, not core.
- [ ] Verify version selection, immutable graph identity, and workflow-specific input rejection.
- [ ] Verify start and resume through the integration service, including an unknown workflow ID.
- [ ] Verify checkpoint commit before ACK, conflict handling, and restoration in a replacement runtime.
- [ ] For external operations, verify receipt reconciliation and explicit recovery without duplicate submission.
- [ ] Run `vp run check` and `vp run test` with normal task caching.
- [ ] Run the relevant end-user workflow when credentials and runtime prerequisites are available.
- [ ] Review the diff for core imports of user-land, including type-only imports, dynamic imports, re-exports, and tests.

The compiler-backed [ownership tests](../tests/feature-boundaries.test.ts) enforce these import boundaries.
A blocked local application startup does not establish browser or Pi acceptance.
If credentials or permissions are missing, report the blocked check and stop instead of bypassing authentication.
