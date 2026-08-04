# `@pactmark/testing`

Deterministic test infrastructure and reusable adapter conformance suites for Pactmark.

The package exports a controllable clock and ID generator, scripted model and tool fakes,
boundary crash injection, a scenario builder, and framework-independent store, tool executor,
and egress contract runners. It is intended only for tests and development dependencies; it
must not be imported by Pactmark production package exports.

Contract runners throw `ContractViolation` at the first violated invariant and otherwise return
an immutable report naming every passed check. They do not depend on Vitest or another test
framework, so adapters can invoke them from their own test runner.

`runStoreContracts` runs the accepted-work-order, input-submission, event, context, artifact, and
lease suites. The lease factory is a harness because the contract must advance adapter time without
consulting host time. Individual runners remain available when an adapter implements only one port.

The adapter conformance runners are:

- `runToolExecutorContract` for exact registration dispatch, runtime JSON/schema validation,
  pre-dispatch abort, and capability/error-surface claims.
- `runEgressBrokerContract` for tenant-bound declared egress, cancellation, and zero transport on
  denied requests. `runEnforcedEgressContract` remains the separate real-isolation probe suite.
- `runRunCommandUnitOfWorkContract` for full-scope replay, changed-request-digest rejection,
  cross-tenant command-record binding, and the advertised atomic command/wakeup capability.
- `runMCPUntrustedToolAdapterContract` for MCP-style protocol boundaries: exposed digest routing,
  malformed input/output rejection, cross-tenant and unexposed-tool denial, abort, and safe public
  errors. Its structural harness keeps protocol SDKs out of this package.

Each runner accepts a factory so every scenario starts from caller-owned adapter state and uses
caller-owned counters or observations. Error checks operate on the public serialization returned by
the harness's `errorSurface` function; secrets used to exercise an upstream failure must not appear
in that JSON-safe surface, and the surface must contain a stable `KAF_*` code.

`@pactmark/testing` belongs in an adapter's `devDependencies` only. Production packages must not
import or re-export these runners. Concrete integrations should live in package-local adapter tests
for executor, egress, durable store, and MCP adapters respectively.

The fakes do not model provider or network behavior beyond their explicit scripts. In
particular, passing an egress contract only proves the behavior exercised by the supplied probe
harness; an adapter may advertise enforced network isolation only when the harness maps every
required probe to a real isolation boundary.
