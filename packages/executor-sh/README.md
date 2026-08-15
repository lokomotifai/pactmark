# @pactmark/executor-sh

Private, production-guarded workspace adapter for invoking reviewed read-only Executor tools through
an already guarded `@pactmark/mcp` connection.

The adapter creates one Pactmark registration per exact Executor tool address. The model never
receives Executor's general-purpose `execute(code)` capability: Pactmark generates a fixed,
single-call code template from canonical JSON input and unwraps only a completed result that passes
the pinned output schema.

## Admission boundary

- The self-host release is pinned to Executor `v1.5.40`, source revision
  `b029643641832ef5f9b0d4ff263d96e1a5b2739c`, and OCI index digest
  `sha256:3e9792043be7819361eada0c5c87ebfa66e996e15772f75a39aae76facd4cb88`.
- Construction fails unless a matching conformance receipt is current and a digest-valid production
  deployment profile binds the tenant, HTTPS origin, opaque connection, platform, and receipt.
- The profile requires one Executor instance per tenant, disabled telemetry/local-network/stdio-MCP,
  UID/GID 65532, a read-only root filesystem, dropped capabilities, `no-new-privileges`, a dedicated
  encrypted data volume, and a named backup policy.
- A conformance receipt expires within seven days. Its digest detects drift; it is not a signature,
  remote attestation, certification, or proof that a production host actually enforces every profile
  assertion. A trusted deployment controller must create and admit profiles.

## Tool boundary

- Only `R0`/`R1`, `effectStrategyKind: "read"` tools are accepted.
- Tool schemas, Executor MCP server identity, the underlying `execute` registration, the opaque
  connection binding, security metadata, and code-template version are digest-bound.
- Unknown, duplicate, malformed, schema-drifted, wrong-server, paused, and errored executions fail
  closed.
- Executor policy remains defense in depth. Pactmark remains authority for registration, grants,
  purpose, budgets, approval, retry classification, and evidence.
- The adapter reports `sandbox: "unsafe_local"` and `networkPolicy: "declared"`. Executor's in-process
  QuickJS runtime and private-network guard do not prove production process isolation or exact
  per-tool egress enforcement.
- The MCP connection lifecycle belongs to the host. This adapter neither discovers credentials nor
  closes the shared connection.

The exact container fixture, API-key and OAuth PKCE paths, cross-tenant denial, backup/restore,
telemetry and network denials, six public GET operations, and independent Node.js 22/24 tarball
consumers have executable gates in `tooling/executor-sh`.

This package is private and is not part of the frozen v0.2 public package set. It must not be
published or represented as general Pactmark production-isolation evidence.
