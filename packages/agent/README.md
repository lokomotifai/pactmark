# @pactmark/agent

The ergonomic Pactmark facade for portable schema, instruction, tool, policy,
agent, command, WorkOrder, authority, and runtime construction.

`createLocalRuntime` is an explicitly ephemeral development profile. It uses
process-local memory stores, a trusted in-process executor, declared egress,
and automatic inline execution. Its production readiness report is always
false. Use `createRuntime` with explicit host-owned ports for production-shaped
composition; the facade supplies no database, credential, scheduler, sandbox,
or provider fallback.

Optional model-provider, Postgres, platform, MCP, and OpenTelemetry adapters are
not re-exported or installed by this package.

Version `0.2.0` is public on npm with verified registry bytes and provenance. This
release status does not change the explicit runtime and production limitations
above.
