# Development workspace retention

This document is for Flowdeck maintainers and operators.
The current PiHarness retention integration is **pending acceptance validation**.

## Workspace ownership

Each Pi development run uses one `DevelopmentRun` Durable Object with official PiHarness and a Computer Workspace backed by `ContainerBackend`.
PiHarness and pi-durable own durable conversation and operation state, while D1 owns workflow checkpoints and events.
The persisted workflow ID remains `jcode-development`, and the Container resource remains `JcodeSandbox`.
Implementation and verification reuse official `ROOT_SESSION = '1'` within that run Durable Object and the Workspace checkout at `/workspace/project`.
The Container uses `HOME=/home/sandbox` and runs official `computerd`, not an embedded Pi SDK or a custom HTTP session gateway.

A node transition does not reset the workspace or conversation.
New runs use runtime `pi-harness`.
Legacy direct-SDK histories remain inspectable but cannot execute through the new harness.
Inspect an interrupted run before taking recovery action.

## Lifecycle renewal

Use official `Lifecycle` from `agents/lifecycle`, installed with PiHarness, and its jobs API rather than a separate lease alarm implementation.
The run Durable Object saves `active-run-id` before workflow execution and schedules the `workspace-lease` job before operation admission.
Lifecycle startup and job execution read the canonical run status from the shared Store.

| Committed run status and Container state | Renewal action                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `completed`                              | Stop renewal. Explicit completion cancels the lease job without destroying the Container.                  |
| Any other status, Container running      | Set the native inactivity timeout to 21,600,000 ms and return a reschedule time of now plus 18,000,000 ms. |
| Any other status, Container stopped      | End renewal without starting the Container.                                                                |
| No saved run ID                          | End renewal.                                                                                               |

The job renews the six-hour native timeout every five hours.
A start or resume operation schedules renewal before admitting work.
The initial timeout is set after the backend accepts the authenticated `computerd` WebSocket upgrade with HTTP 101.
For an already running Container, Lifecycle `onStart` and the lease job renew the timeout.
This is not a promise that every job runs before the inactivity deadline.
Use official Lifecycle scheduling and retry behavior instead of a custom alarm dispatcher.
Delayed renewal schedules from the current time, not an old anchor.
Renewal does not submit Pi operations, call inference, replay missed intervals, or advance workflow nodes.
Only explicit workflow resume advances a waiting checkpoint.
The renewal job never starts a stopped Container.

## Cost and recovery limits

**A running Container continues to incur charges while its workflow is failed, waiting, pending, or running.**
Failed work remains available for inspection.
There is no automatic failure cleanup or retention deadline in this workflow.
An operator must explicitly stop a workspace when it is no longer needed.

A completed run stops renewal but does not immediately destroy the Container.
The native inactivity policy can subsequently stop it.
Durable Pi conversation and operation state are distinct from Workspace filesystem state and Container-local process state.
Do not assume that a retained conversation restores lost shell effects, background processes, or all Container-local files after replacement.
A retained Container is not a generic replay checkpoint or permanent artifact store.
Track these limits in [workspace-loss recovery #11](https://github.com/totto2727-org/flowdeck/issues/11).

## Validation boundary

Current live implementation, explicit-resume verification, and five/six-hour retention acceptance remain **pending**.
The coordinating root session will provide final results for the latest implementation.
Prior direct-SDK acceptance and custom lease tests do not validate the official Lifecycle/PiHarness path.
Synthetic boundary tests and image smoke checks do not establish workspace survival, recovery after replacement, or normal cached target CI.
[Dependency provisioning and cached tasks #14](https://github.com/totto2727-org/flowdeck/issues/14) remains a concern requiring current evidence, not a result inherited from the previous runtime.
See [sandbox acceptance limits](development-sandbox.md#trust-and-acceptance-boundary) for the full credential, setup, and acceptance scope.

## Sources

- Official installed APIs: `agents/lifecycle`, `agents/harness/pi`, `@earendil-works/pi-durable`, and `@cloudflare/computer/backends/container`.
- Integration: the runtime entry and Container resource composition under `src/workers/development-workflow/`.
- [Cloudflare Container inactivity timeout](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout)
- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
