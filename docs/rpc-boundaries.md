# RPC boundaries

## Contract

Worker and Durable Object RPC calls are external API boundaries.
Each application-owned RPC method returns JSON text, not a domain object, an `Error` instance, or a rejected domain failure.
The shared Schema codec accepts either a success envelope with a JSON value or a failure envelope with a Problem Details object.
Commands return JSON `null` as their successful value.
Domain values use their JSON codecs before entering the response boundary.
Each receiver decodes the envelope and its operation-specific value before using the result.

The error representation uses the JSON model from [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html#section-3), embedded in the RPC failure envelope as described in [Appendix D](https://www.rfc-editor.org/rfc/rfc9457.html#appendix-D).
This does not make native Worker RPC an HTTP transport.
The `status` field describes the corresponding HTTP failure, not a native RPC transport status.
Problem type identifiers are the absolute URLs of the definitions below.

## Failure flow

1. The failing service records its original Effect cause and stack with the operation name and a unique `errorId`.
2. The service creates a Problem Details object with `type`, `title`, `status`, `detail`, and `instance`.
3. The service returns the encoded failure envelope.
4. The caller validates the response and creates a new local `RemoteWorkerError`, with the validated problem object as its required `cause`.
5. If the caller is another RPC service, its boundary records that local error with a new error ID and returns a new problem occurrence.

The `instance` field is an absolute `urn:uuid:` URI and equals the `errorId` in the originating log.
An intermediate service's log contains both its own error ID and the preceding problem occurrence in its local error cause.
Follow these IDs through the logs to reach the service that has the original stack.
The wire response contains no stack, original cause, private message, request body, or error-class instance.
There is no remote error-class revival and no recovery decision based on a restored child exception.
Transport failures are local failures at the caller, not serialized domain responses from the callee.
Cancellation-only interruption remains cancellation and does not produce a failure log.

Native Alchemy Worker RPC and native Cloudflare entrypoints do not expose the Effect RPC server middleware hook.
The shared codec adapter is confined to those entrypoints.
HTTP interception and failure translation remain registered `HttpRouter.middleware` implementations.

## Problem types

Each heading defines a type URI by appending its fragment to this document's canonical URL.
The detail is a fixed, public description, not the original exception message.

### Not found

Status: 404.
The requested run or graph does not exist.

### Conflict

Status: 409.
The run changed concurrently, or a delivery identity was reused with different content.

### Invalid operation

Status: 409.
The current workflow state does not permit the requested operation.

### Invalid snapshot

Status: 409.
Persisted workflow state does not satisfy the workflow contract.

### Storage

Status: 500.
A persistence operation failed.

### Service

Status: 502.
A required service could not complete the operation.
The persisted workflow checkpoint remains available for explicit recovery.

### Invalid request

Status: 400.
The request does not satisfy the operation's input schema.

### Internal

Status: 500.
An unexpected failure prevented completion.
The error ID identifies the service log that contains diagnostic information.
