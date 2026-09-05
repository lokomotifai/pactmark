# @pactmark/agent

The ergonomic Pactmark facade for portable schema, instruction, tool, policy,
agent, command, WorkOrder, authority, and runtime construction.

`createLocalRuntime` is an explicitly ephemeral development profile. It uses
process-local memory stores, a trusted in-process executor, declared egress,
and automatic inline execution. Its production readiness report is always
false. Use `createRuntime` with explicit host-owned ports for production-shaped
composition; the facade supplies no database, credential, scheduler, sandbox,
or provider fallback.

The local profile includes a process-local human-decision surface for R4
fixture writes. Callers must use an authority with the required authentication
strength, issue a one-use challenge, record approval or rejection, and
explicitly resume when no scheduler is configured. Challenge proofs and claims
are not durable; this feature demonstrates the contract and does not turn the
ephemeral profile into a production approval service.

Optional model-provider, Postgres, platform, MCP, and OpenTelemetry adapters are
not re-exported or installed by this package.

Version `0.2.0` is publicly released with independently verified registry bytes
and npm SLSA provenance. This supply-chain status does not change the explicit
runtime and production limitations above.
