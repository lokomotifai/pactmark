# Portable catalog agent

This agent performs one R1 read over an embedded catalog. `src/agent.ts` is host-neutral: it does not import Node built-ins, environment variables, filesystem APIs, or a host SDK. Host entrypoints translate requests only.

The example claims event, tool-result, artifact, and error-code parity for this fixture. It does not claim durable resume, sandbox isolation, or background execution.
