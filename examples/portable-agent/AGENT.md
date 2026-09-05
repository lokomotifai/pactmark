# Portable catalog agent

This agent performs one R1 read over an embedded catalog through Pactmark's
local runtime. `src/agent.ts` is host-neutral: it does not import Node built-ins,
environment variables, filesystem APIs, or a host SDK. Host entrypoints
translate requests only.

The example claims normalized event-type, tool-result, artifact, and error-code
parity for this fixture. Per-run identifiers and timestamps are intentionally
not part of that parity claim. It does not claim durable resume, sandbox
isolation, authentication, tenancy, or background execution.
