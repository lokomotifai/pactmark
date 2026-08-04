# ADR-0004: Provider and platform adapters

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Pactmark maintainers

## Context

Model SDKs, tool protocols, telemetry libraries, stores, and deployment hosts
change at different rates and expose different capabilities. Letting any one of
them define run semantics would make authority, durability, and evidence claims
provider-dependent.

## Decision

Core contracts are provider- and platform-neutral. Adapters translate external
capabilities into Pactmark ports and normalized events/results; they do not own
policy, tool execution, effect authorization, or run-state transitions.

Portable HTTP surfaces use WHATWG `Request`, `Response`, `ReadableStream`,
`AbortSignal`, `fetch`, and Web Crypto-compatible primitives. Node-specific
behavior stays in Node/storage/worker packages.

The Vercel AI SDK is isolated in the optional `ai-sdk` adapter. It may normalize
streaming text, structured output, usage, tool requests, aborts, errors, and
finish reasons, but Pactmark runtime remains the only tool executor. AI SDK
types and experimental agent abstractions must not leak into core.

The official MCP TypeScript SDK is isolated behind a guarded optional adapter.
MCP metadata and output remain untrusted and cannot create grants, approvals,
secrets, or wider egress.

Platform posture for v0.1 is:

- Node.js/OCI and Vercel Node are intended Tier 1 targets after their exact
  acceptance suites pass;
- Cloudflare Workers is a tested portability preview, not a Tier 1 durability
  claim;
- Vercel Edge is experimental and not a v0.1 blocker.

A local build proves only build compatibility. Deployment, resume, cancellation,
streaming, readiness, and log claims require an attested test of the exact
candidate bytes on the named platform.

## Consequences

- Platform SDKs are peer or optional dependencies of their adapter.
- Adapter registration identities include security- and capability-relevant
  behavior so drift changes the digest.
- Provider credentials are resolved outside reusable agent definitions and are
  not interchangeable with tool credentials.
- Hosts can supply stricter executors, egress, secret stores, and scheduling
  without forking core.
- Documentation must label each platform as tested, preview, experimental,
  planned, or unsupported based on evidence.

## Rejected alternatives

- **Vercel AI SDK as kernel:** exposes provider abstractions as Pactmark's public
  execution model.
- **Tools executed by the model SDK:** can bypass policy and effect controls.
- **Shared provider/platform package:** creates unnecessary transitive
  dependencies and mixed authority boundaries.
