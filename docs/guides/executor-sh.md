---
title: Production-guarded Executor gateway
description: Bind reviewed read-only Executor tools without delegating Pactmark authority.
---

> Compatibility: Pactmark 0.1.x. Status: **private, production-guarded integration**.

`@pactmark/executor-sh` maps reviewed Executor tools onto independent Pactmark registrations. It uses
an already guarded `@pactmark/mcp` connection but never gives the model Executor's generic
`execute(code)` registration. The package is private, not published, and outside the frozen v0.1
public package set.

## Authority boundary

Pactmark remains authority for risk, grants, purpose, budgets, approval, retry classification, and
evidence. Executor owns integration protocol handling and may attach its stored connection credential
to an upstream request. Executor policy and toolkit configuration are defense in depth only.

The adapter accepts only `R0`/`R1` registrations with `effectStrategyKind: "read"`,
`reversibility: "not_applicable"`, declared allowlist egress, and
`networkEnforcement: "declared_ok"`. A read may use upstream `POST` when the reviewed operation is
semantically read-only, but that classification must come from the operator rather than the HTTP
method or Executor metadata.

## Production admission

The integration pins Executor `v1.5.40`, source revision
`b029643641832ef5f9b0d4ff263d96e1a5b2739c`, and OCI index digest
`sha256:3e9792043be7819361eada0c5c87ebfa66e996e15772f75a39aae76facd4cb88`.
Run the exact container gate after bootstrapping that digest: first
`pnpm bootstrap:executor-sh-image`, then `pnpm test:executor-sh-container`.

The host must supply a receipt valid for no more than seven days and a matching production deployment
profile. The profile binds one tenant to one Executor instance, an exact system-trusted HTTPS origin,
opaque connection reference, platform manifest, and receipt. It also requires disabled telemetry,
analytics, local-network access, and stdio MCP; UID/GID 65532; read-only root; dropped capabilities;
`no-new-privileges`; a dedicated encrypted data volume; and a named backup policy.

The receipt digest detects drift in the recorded observation. It is not a signature, remote
attestation, certification, or proof about an arbitrary production host. Create and admit it only in
a trusted deployment controller. Enforce the declared per-tool egress allowlist in infrastructure;
Executor's local/private-address guard is not exact per-tool egress enforcement.

## Host wiring

The host creates an `MCPConnection` that pins the Executor HTTPS endpoint, server identity, `execute`
schema, credential origin, purpose, and grant. Keep this connection and its exposed `execute`
registration outside every model-facing registry.

Then bind the tenant deployment profile and exact upstream tool pin:

<!-- pactmark:snippet source=docs/snippets/executor-sh-host-wiring.ts language=ts -->

The pin binds the exact server, Executor `execute` registration, connection reference, address,
schemas, security metadata, effect strategy, and code-template version. Catalog discovery never
updates it automatically. A change requires a new reviewed pin and registration version.

## Runtime behavior

For each invocation the adapter verifies the deployment profile and current receipt, validates the
exact Pactmark registration and input schema, generates a fixed single-call script from canonical
JSON, calls the pinned MCP `execute` tool once, rejects paused/error states, validates the returned
result schema, and discards Executor logs from its return surface.

Connection and upstream failures are surfaced only through safe `KAF_EXECUTOR_*` codes. Read-only
transport failures may be classified retryable; this classification must not be copied to a future
write adapter.

## Executable evidence

The digest-pinned local Docker fixture verifies non-root/read-only hardening, resource limits,
restart persistence, stopped-volume backup/restore, telemetry and analytics opt-out, denied outbound
and private networking, disabled stdio MCP, unauthenticated denial, API-key MCP, OAuth PKCE,
cross-tenant credential denial, canary-safe logs, and the real `execute` envelope.

The separate network-authorized gate, `pnpm test:executor-sh-read-tools:live`, registers and invokes
six GET-only NPM download operations through the real self-hosted Executor MCP path.

It makes no external writes and uses no SaaS credential. `pnpm test:executor-sh-packed` independently
installs only packed `core`, `mcp`, and `executor-sh` tarballs; CI runs that gate on Node.js 22 and 24.

## Unsupported and unproven

- Writes, automatic approval, `resume`, and multi-call code programs are unsupported.
- Executor catalog entries and policy annotations do not create Pactmark registrations or grants.
- The adapter reports `sandbox: "unsafe_local"` and `networkPolicy: "declared"`.
- Shared multi-tenant Executor instances are rejected by the deployment contract.
- The fixture does not prove arbitrary-code isolation, container-escape resistance, availability, or
  the configuration of a separate production environment.
- Each production target still needs trusted TLS termination, encrypted volume/key management,
  backup/restore operations, exact egress controls, monitoring, credential rotation, and a fresh
  target-specific receipt.
