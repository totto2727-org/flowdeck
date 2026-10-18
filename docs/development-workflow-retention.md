# Development workspace retention

This document is for Flowdeck maintainers and operators.

## Container ownership

Each `jcode-development` run uses one `DevelopmentRun` Durable Object and its attached native Cloudflare Container.
Implementation and verification use the same SDK session and `/home/sandbox/workspace/project` directory.
A node transition does not stop the container.
A stopped container is not automatically recreated after the persisted startup attempt marker is set.
Inspect an interrupted run before you take recovery action.

## Retention heartbeat

The Durable Object saves its run ID under `active-run-id` before each start or resume operation.
Its constructor, alarm handler, and operation finalizers read the canonical run status from the shared Store.
A finalizer also runs when the gateway returns a binding error after container startup.

| Committed run status and container state | Action                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `completed`                              | Delete the alarm. Do not destroy the container.                                                                           |
| Any other status, container running      | Set the native inactivity timeout to 21,600,000 ms, then schedule the next alarm for the current time plus 18,000,000 ms. |
| Any other status, container stopped      | Delete the alarm. Do not restart the container or schedule another heartbeat.                                             |
| No saved run ID                          | Delete the alarm.                                                                                                         |

The heartbeat renews the six-hour native timeout every five hours.
SDK execution inside a container is not itself a Durable Object request.
The heartbeat does not poll SDK turns, submit commands, or advance workflow nodes.
Only an explicit resume operation advances the workflow.
A delayed or repeated alarm uses the current clock time, not an old schedule anchor.
Missed heartbeat intervals are not replayed.
Concurrent heartbeat calls within one object instance use a semaphore.
A storage or native container failure remains visible as a failed alarm invocation, so native Durable Object alarm retry behavior applies.
This does not guarantee that the runtime will deliver every alarm before the inactivity deadline.

## Cost and inspection

**A running container continues to incur charges while its workflow is failed, waiting, pending, or running.**
The failed status does not mean that the workspace is safe to delete.
This policy keeps failed SDK work available for inspection.
There is no automatic failure cleanup or retention deadline in this workflow.
An operator must explicitly stop a workspace when it is no longer needed.

A completed run stops heartbeat renewal but does not immediately destroy the container.
The native inactivity policy can subsequently stop it.
Do not treat the writable workspace as permanent artifact storage.
A stopped container is not a replay checkpoint and cannot be recreated safely by the heartbeat.

## Validation boundary

The maintained lease tests use the native Alchemy API types and a controlled Effect clock.
They verify timeout requests, alarm scheduling, completion cancellation, stopped-container behavior, failed-run retention, delayed delivery, and binding-error finalization.
They do not prove that a real container survives a six-hour runtime interval.

## Sources

- [Cloudflare Container Durable Object interface](https://developers.cloudflare.com/containers/platform-details/durable-object-interface/)
- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- Native Alchemy `ContainerClient`, `DurableObjectState`, and `DurableObjectStorage` APIs used by `src/workers/development-workflow/index.ts`.
