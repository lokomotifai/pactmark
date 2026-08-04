# ADR-0002: Package boundaries and dependency direction

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Pactmark maintainers

## Context

The kernel must work across Node.js, Vercel, Cloudflare-compatible Web
runtimes, model providers, and storage implementations. Convenience imports can
quietly make a supposedly portable package depend on Node.js, a provider SDK,
or a concrete database.

## Decision

Pactmark uses small ESM-only packages in a pnpm/Turborepo workspace. Published
packages expose explicit exports, declarations, source maps, and an allowlisted
set of packed files. Production import cycles are forbidden.

The production dependency direction is:

```text
policy, evidence, store-memory, store-postgres, ai-sdk, mcp, otel,
executor-in-process -> core

runtime -> core
driver-postgres-worker -> core, runtime, store-postgres
http -> core, runtime
node, vercel, cloudflare -> core, runtime, http
agent -> core, runtime, policy, evidence, store-memory, executor-in-process
testing -> core, runtime, policy, evidence, store-memory
cli -> agent, core, evidence
initializer -> published metadata and embedded templates; never workspace imports
```

`core`, `policy`, `runtime`, and `evidence` must not import provider/platform
SDKs or Node.js built-ins. They receive clock, ID generation, persistence,
environment, logging, models, secrets, tool execution, egress, and scheduling
through ports. `runtime` consumes concrete policy, verifier, evidence, store,
transaction, driver, executor, and egress behavior only through ports defined
in `core`.

Adapter tests may depend on the testing package as a development dependency,
but testing imports must not leak into production exports. The CLI receives
host-provided migration behavior through a core port instead of dynamically
importing a concrete database adapter.

The `agent` package is the ergonomic default surface. Database, MCP,
observability, model-provider, and deployment packages remain optional rather
than transitive requirements of a basic consumer.

## Consequences

- Dependency-boundary checks are release gates, not style suggestions.
- Some wiring is explicit even where direct imports would be shorter.
- Platform packages can evolve without changing kernel wire semantics.
- A new package boundary or reversed edge requires a superseding ADR.

## Rejected alternatives

- **Single package:** makes optional integrations mandatory and obscures
  portability violations.
- **Runtime imports concrete implementations:** prevents host substitution and
  couples deterministic semantics to infrastructure.
- **Dynamic optional imports from the CLI:** bypasses the auditable graph.
