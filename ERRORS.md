# Stable error reference

Pactmark exposes stable `KAF_*` codes so consumers can branch on codes instead
of parsing English messages. This page is the public target for HTTP problem
types and CLI diagnostic links. It describes recovery boundaries; it does not
expose internal causes, credentials, or sensitive diagnostic details.

For a `KafError`, use the code, `retryable` flag, HTTP status, and request ID
together. Retry only when the returned flag permits it and the external effect
strategy proves that another attempt is safe. Unknown errors remain
non-retryable.

## Core errors

<a id="schema-invalid"></a>

### `KAF_SCHEMA_INVALID`

Validate the value against the documented runtime schema before resubmitting.

<a id="serialization-invalid-json"></a>

### `KAF_SERIALIZATION_INVALID_JSON`

Send valid JSON without truncated or malformed input.

<a id="serialization-duplicate-key"></a>

### `KAF_SERIALIZATION_DUPLICATE_KEY`

Remove duplicate object keys before canonicalization.

<a id="serialization-invalid-unicode"></a>

### `KAF_SERIALIZATION_INVALID_UNICODE`

Replace invalid Unicode sequences with valid scalar values.

<a id="serialization-number"></a>

### `KAF_SERIALIZATION_NON_I_JSON_NUMBER`

Use an I-JSON-compatible finite number.

<a id="serialization-unsupported-value"></a>

### `KAF_SERIALIZATION_UNSUPPORTED_VALUE`

Convert the value to a supported JSON representation.

<a id="serialization-cycle"></a>

### `KAF_SERIALIZATION_CYCLIC_VALUE`

Remove cyclic object references before serialization.

<a id="runtime-invalid-transition"></a>

### `KAF_RUNTIME_INVALID_TRANSITION`

Reload the run and issue an operation valid for its current state.

<a id="runtime-terminal"></a>

### `KAF_RUNTIME_TERMINAL`

Do not submit additional transitions to a terminal run.

<a id="runtime-event-sequence"></a>

### `KAF_RUNTIME_EVENT_SEQUENCE`

Reload the append-only event tail and retry only from the observed sequence.

<a id="runtime-event-binding"></a>

### `KAF_RUNTIME_EVENT_BINDING`

Reject the event and verify its tenant, run, and execution-definition binding.

<a id="runtime-agent-definition-mismatch"></a>

### `KAF_RUNTIME_AGENT_DEFINITION_MISMATCH`

Use the immutable agent definition accepted with the run.

<a id="effect-invalid-transition"></a>

### `KAF_EFFECT_INVALID_TRANSITION`

Reconcile the effect ledger before requesting another transition.

<a id="effect-abandoned-uncertain"></a>

### `KAF_EFFECT_ABANDONED_UNCERTAIN`

Treat the external effect as possibly completed and resolve it operationally.

<a id="authorization-binding-mismatch"></a>

### `KAF_AUTHORIZATION_BINDING_MISMATCH`

Obtain authority bound to the exact tenant, run, tool, target, and request.

<a id="authorization-expired"></a>

### `KAF_AUTHORIZATION_EXPIRED`

Obtain fresh authority; do not extend expired authority locally.

<a id="policy-denied"></a>

### `KAF_POLICY_DENIED`

Inspect the stable policy reason code and change the request or host policy.

<a id="admission-denied"></a>

### `KAF_ADMISSION_DENIED`

Respect the returned retry window or reduce the requested resource use.

<a id="storage-concurrency-conflict"></a>

### `KAF_STORAGE_CONCURRENCY_CONFLICT`

Reload authoritative state before a policy-safe retry.

<a id="storage-not-found"></a>

### `KAF_STORAGE_NOT_FOUND`

Verify the tenant-scoped identifier without assuming another tenant's resource
exists.

<a id="storage-security-profile"></a>

### `KAF_STORAGE_SECURITY_PROFILE`

Correct the storage allowlists, protection, transport, tenant isolation, or
operator configuration named by the safe reason.

<a id="runtime-capability-missing"></a>

### `KAF_RUNTIME_CAPABILITY_MISSING`

Provide the required host capability or choose a compatible runtime profile.

<a id="runtime-not-ready"></a>

### `KAF_RUNTIME_NOT_READY`

Keep the instance out of service until all required readiness checks pass.

<a id="model-resource-limit-exceeded"></a>

### `KAF_MODEL_RESOURCE_LIMIT_EXCEEDED`

Reduce the request or use an explicitly registered model resource profile.

<a id="model-credential-required"></a>

### `KAF_MODEL_CREDENTIAL_REQUIRED`

Configure the host-owned credential issuer and resolver boundary.

<a id="model-adapter-mismatch"></a>

### `KAF_MODEL_ADAPTER_MISMATCH`

Use the adapter and model profiles whose immutable digests were accepted.

<a id="verification-required"></a>

### `KAF_VERIFICATION_REQUIRED`

Complete the registered verification before consuming the result.

<a id="evidence-invalid-reference"></a>

### `KAF_EVIDENCE_INVALID_REFERENCE`

Reject the evidence and rebuild it from authoritative run records.

<a id="pattern-insufficient-evidence"></a>

### `KAF_PATTERN_INSUFFICIENT_EVIDENCE`

Collect the required independent evidence before raising pattern maturity.

<a id="command-idempotency-expired"></a>

### `KAF_COMMAND_IDEMPOTENCY_EXPIRED`

Do not assume an expired idempotency key still protects a repeated effect.

<a id="http-idempotency-conflict"></a>

### `KAF_HTTP_IDEMPOTENCY_CONFLICT`

Use the original request content or a new idempotency key for a distinct command.

## HTTP errors

HTTP-adapter `KAF_HTTP_*` errors describe authentication, authorization, request
shape, size, integrity, routing, CORS, CSRF, rate-limit, or response constraints.
Correct the named code and preserve the returned request ID. A concealed `404`
must not be interpreted as proof that a resource does not exist in another
tenant.

## CLI errors

CLI `KAF_CLI_*` errors include a safe remediation string. Correct arguments,
local host configuration, tenant authority, evidence integrity, authoring input,
or local file access as indicated. Debug mode reveals only a redacted error type,
not the internal cause or secrets.
