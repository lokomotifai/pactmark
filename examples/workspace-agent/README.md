# Workspace agent

The required scenario runs against a bounded virtual filesystem and exercises allowlisted roots, draft artifacts, path and symlink denial, command/output/time limits, cancellation, and redaction.

```sh
pnpm --filter pactmark-example-workspace-agent test
pnpm --filter pactmark-example-workspace-agent typecheck
pnpm --filter pactmark-example-workspace-agent build
pnpm --filter pactmark-example-workspace-agent dev
```

`unsafe_local_development` is a capability label, not a sandbox guarantee. The included container contract fixture describes a minimum adapter boundary but does not claim arbitrary-code isolation or production hardening.
