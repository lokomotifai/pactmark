# ADR-0008: Production-guarded private Executor gateway adapter

- Status: Accepted
- Date: 2026-08-11
- Decision owners: Pactmark maintainers
- Scope: private workspace integration; not part of the v0.1 public package set

## Context

Executor can normalize MCP, OpenAPI, GraphQL, and provider integrations behind one catalog while
keeping provider credentials in its host. Pactmark can benefit from that protocol and credential
gateway, but Executor's generic `execute(code)` surface, policy metadata, in-process QuickJS runtime,
and connection catalog cannot become Pactmark authority or general production-isolation evidence.

ADR-0002 requires a superseding decision for a new package boundary. This ADR adds only the private
leaf boundary described below; it does not change the published v0.1 graph.

## Decision

Add private package `@pactmark/executor-sh` with dependency direction:

```text
executor-sh -> core, mcp
```

The package consumes an already guarded `MCPConnection`. It verifies that the connection exposes the
exact pinned Executor `execute` registration, then creates one independent Pactmark registration per
reviewed upstream Executor tool address.

The implementation accepts only `R0`/`R1` read tools with declared allowlist egress. It binds the
Executor server identity, underlying `execute` registration, tenant-specific opaque connection,
exact tool address, input/output schemas, Pactmark security metadata, read effect strategy, and
generated code-template version into canonical digests.

The model never receives the generic Executor `execute(code)` registration. The adapter generates a
fixed script containing one `tools[path](input)` call from canonical JSON, sends it through the guarded
MCP connection, refuses paused/error states, and returns only schema-valid completed JSON.

Production construction additionally requires a current conformance receipt and matching deployment
profile. The upstream release is pinned to Executor `v1.5.40`, source revision
`b029643641832ef5f9b0d4ff263d96e1a5b2739c`, and OCI index digest
`sha256:3e9792043be7819361eada0c5c87ebfa66e996e15772f75a39aae76facd4cb88`.
The profile requires one instance per tenant, a system-trusted exact HTTPS origin, disabled telemetry,
local-network access, and stdio MCP, a non-root read-only container with bounded privileges/resources,
an encrypted dedicated volume, and an identified backup policy.

## Security and operational boundary

- Pactmark remains authority for tool registration, risk, grants, purpose, budgets, approval, retry
  classification, and evidence.
- Executor policies and toolkits are defense in depth and never grant Pactmark authority.
- The adapter reports `sandbox: "unsafe_local"` and `networkPolicy: "declared"`.
- The host owns and protects the underlying MCP connection. No model-facing or application-generic
  reference to its `execute` registration may be exposed.
- One adapter and Executor instance is bound to one tenant by the deployment profile and connection
  digest. Shared multi-tenant composition is not admitted.
- A receipt is valid for at most seven days and detects canonical-material drift. It is not signed
  attestation and does not prove that an arbitrary production host enforces the recorded assertions.
  A trusted deployment controller must own receipt creation and profile admission.
- Infrastructure must enforce the exact egress allowlist, TLS, encrypted storage, backup operations,
  credential rotation, and monitoring. Executor's address guard is defense in depth.
- The package stays private and removable. Publication requires a separate naming and release
  decision; deployment requires target-specific infrastructure evidence.

## Executable evidence

The digest-pinned Docker conformance gate covers platform identity, non-root/read-only hardening,
resource limits, restart persistence, stopped-volume backup/restore, telemetry and analytics opt-out,
outbound/private-network denial, disabled stdio MCP, API-key and OAuth PKCE authentication,
cross-tenant credential denial, secret canaries, and the actual completed envelope.

A separate network-authorized gate registers and invokes six GET-only public NPM API operations
through the self-hosted Executor MCP path. The independent packed-consumer gate installs only tarballs
and runs on Node.js 22 and 24. These fixtures provide bounded evidence for their exact environments;
they are not a production deployment attestation or arbitrary-code sandbox proof.

## Consequences

- Pactmark can exercise Executor-backed reads without importing Executor's SDK or its peer dependency
  chain.
- Unknown, duplicate, malformed, schema-drifted, wrong-server, expired-deployment, paused, and
  unreviewed tools fail closed.
- Generic write tools, automatic catalog authority, automatic approval, effect reconciliation,
  shared multi-tenant composition, and production sandbox claims remain unsupported.
- A production operator must continuously reproduce deployment-specific TLS, storage, backup,
  egress, credential, monitoring, and fresh-receipt evidence.

## Rejected alternatives

- **Expose Executor `execute` directly to the model:** loses per-tool registration and permits opaque
  multi-call programs.
- **Import the Executor SDK into core/runtime:** violates adapter isolation and current dependency
  policy.
- **Treat Executor policy as Pactmark policy:** trusts heuristic or upstream-controlled metadata as
  authority.
- **Enable writes in the first adapter:** bypasses the required per-tool idempotency, preview,
  uncertainty, and reconciliation review.
