# `@pactmark/cli`

The safe, host-injected command-line interface for Pactmark. It provides the `pactmark` binary and a public `runCli` API for embedding the same commands in a project host.

Set `PACTMARK_CLI_CONFIG` to a trusted local ESM module whose default export implements `PactmarkCliHost`. The CLI never discovers database or provider adapters dynamically. `doctor` preserves the core runtime's readiness result and augments it with typed host probes; `migrate` delegates only to an injected `MigrationManager`.

```sh
pactmark --help
pactmark compile --json
pactmark doctor --production --json
pactmark replay run_123 --json
pactmark inspect run_123 --json
pactmark evidence export run_123 --format json
```

Output is telemetry-free. Human terminal output escapes control, ANSI, bidi, zero-width, and combining characters. JSON errors expose stable `KAF_*` codes, a remediation, and a documentation URL; raw causes, stacks, credentials, provider bodies, and environment values are never rendered.

`compile` is hostless: it reads `AGENT.md`, optional `skills/<name>/skill.json`, `SKILL.md`, resources, and optional `.pactmark/capabilities.json`. It rejects unsupported encodings, symlinks and path escapes, stale schemas, unresolved capabilities, and possible embedded secrets before atomically materializing `.pactmark/generated/agent-manifest.json`.

`replay` accepts only terminal runs. It reduces the finite stored event history and compares projection, event-chain, and artifact digests through read-only host ports. It never invokes the host's `operate` callback, a model, or a tool. Commands requiring orchestration beyond these concrete read-only or local paths use the authenticated host's `operate` callback. The host remains responsible for an interactive or authenticated R4/R5 decision flow and for operational authority on effect reconciliation or compensation; CLI flags and payloads do not create that authority. If a host omits the callback, the CLI fails with `KAF_CLI_COMMAND_UNSUPPORTED`; it never reports simulated success.
