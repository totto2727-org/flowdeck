# D1 storage for ClusterMachine

## Scope

`D1ClusterMachineStorage` implements the official `ClusterMachine.Storage` service from `@typeonce/effect-machine/cluster`.
It persists machine checkpoints and processed request IDs through the existing captured Alchemy D1 client and Reylo query runner.
It is an opt-in integration capability, independent from the ordinary Machine workflow runtime.
Workflow Workers use native start/resume and invokes through the shared persistence host, not this Cluster adapter.

Use this adapter with non-emitting machines and without an `enqueue` handler.
It does not provide a durable Cluster mailbox, Sharding runtime, or atomic checkpoint-and-emission transaction.

## Layer composition

The adapter requires only `D1Client` and provides the official `ClusterMachine.Storage` service.
Compose the selected database Layer once at the runtime composition boundary:

```ts
import { Layer } from 'effect'

import { D1ClusterMachineStorage } from '@/features/cluster/d1-storage'

const ClusterStorageLive = D1ClusterMachineStorage.pipe(Layer.provide(DatabaseClientLive))
```

Here `DatabaseClientLive` is the application's already selected `Layer` providing `D1Client`, not a new database resource.
The existing Workers obtain that client from Alchemy's `QueryDatabaseBinding`.
Local integration tests instead compose `NativeD1Client` with a real Miniflare `D1Binding`.
Do not use `D1Client.fromBinding` for a deferred database-ID client or `QueryDatabaseLocal`.
See [database workflow](database.md) for that captured-client boundary.

`ClusterMachine.make(entityType, machine, { version }).toLayer()` still requires official `MessageStorage`, `Sharding`, and the machine's own dependencies in addition to this storage Layer.
Supply those services at the same composition boundary.
Do not substitute a process-local mailbox for durable production messaging and describe it as durable Cluster execution.

## Data and execution

Two tables keep the current checkpoint separate from request history:

- `cluster_machine_checkpoints` stores the machine ID, version, last request ID, and encoded snapshot.
- `cluster_machine_requests` stores every committed request ID for that entity address.

Both tables use the complete address: shard group, shard ID, entity type, and entity ID.
Snowflake request IDs are stored as text through the official `SnowflakeFromString` codec, without conversion to JavaScript numbers.
The snapshot codec validates the public version-2 encoded envelope.
The official machine adapter remains responsible for decoding machine-specific state and validating machine identity and version.

`load` uses one typed SQL query to read the latest checkpoint and check the requested receipt.
`commit` prepares two typed SQL statements and submits one native D1 batch:

1. Insert or update the checkpoint only if this request ID has no receipt.
2. Insert its receipt, with a duplicate-key no-op.

The second statement's D1 change count reports `Committed` or `Duplicate`.
There is no pre-read or acknowledgment query in the commit path.
The checkpoint and receipt either both commit or both roll back.
An older duplicate cannot overwrite a newer checkpoint, even if the retried payload differs.
Concurrent copies of the same request produce one committed receipt.
Retain historical receipts when the current checkpoint advances; deleting them would remove deduplication for older requests.

The official Entity runtime must serialize different requests for one entity.
This storage contract has no expected-revision parameter and does not provide compare-and-swap for independently planned concurrent requests.

`features/cluster/` owns these SQL statements, codecs, and `PersistenceError` translation.
It depends only on `features/d1/` within application source, not workflow policy or Worker resource declarations.
Database failures retain their original cause, while Effect interruption remains interruption.

## Transaction limit

The official adapter wraps request processing in `MessageStorage.withTransaction` and can enqueue emissions after checkpoint persistence.
A separate D1 batch does not automatically join that transaction.
This implementation guarantees checkpoint-and-receipt atomicity only, not atomicity with emitted messages or external side effects.
A future durable D1 mailbox integration must give checkpoint writes and message insertion one actual transaction boundary before enabling emission guarantees.
The application workflows instead use ordinary Machine invokes, explicit D1 checkpoints, and receipt reconciliation as described in [Workflow graphs](workflow-graphs.md).

## Verification

The maintained [integration tests](../src/features/cluster/d1-storage.test.ts) initialize real Miniflare D1 from the generated project migration and use the official Alchemy native client.
They exercise the storage service and the official Cluster Entity client rather than a copied transition interpreter.
Delegated native-client observations check the two-statement, one-batch commit and one-query load while still executing real D1 operations.
Round-trip checks preserve active state values, completion outputs, and history as well as the checkpoint's identity and version.
The official `TestRunner.layer` supplies the actual `Sharding.layer` with in-memory message and runner storage; the tests call `Entity.client`, not `Entity.makeTestClient` or copied handlers.
A real D1 receipt failure must become a public `Rejected` result with reason `PersistenceFailure`, leave no checkpoint or receipt, and permit a reconstructed host to accept the next request after the fault is removed.
The [schema tests](../tests/database.test.ts) check snapshot JSON and receipt foreign-key constraints.
The [feature-boundary tests](../tests/feature-boundaries.test.ts) enforce the cluster capability's dependency cut.

These are local integration checks, not a deployed Cloudflare Cluster acceptance test.
No existing workflow is switched to this adapter, and no production Cloudflare resource is deployed by this change.

## Official references

- [ClusterMachine API](https://effect-machine.typeonce.dev/unstable/cluster/ClusterMachine/)
- [ClusterMachine source](https://github.com/typeonce-dev/effect-machine/blob/main/src/unstable/cluster/ClusterMachine.ts)
- [Cluster request processing](https://github.com/typeonce-dev/effect-machine/blob/main/src/internal/machine/cluster.ts)
- [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
