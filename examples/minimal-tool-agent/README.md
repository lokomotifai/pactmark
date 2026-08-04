# Minimal deterministic tool agent

This example completes a no-key run with one R1 read tool over an immutable
in-memory fixture. It streams ordered events, stores the final artifact, and
exports the runtime-built evidence record. Its memory-backed runtime is an
ephemeral development profile and deliberately fails production readiness.

```sh
pnpm --filter pactmark-example-minimal-tool test
pnpm --filter pactmark-example-minimal-tool dev
```

No network or external account is used. The result supports only what the
embedded fixture contained during this run.
