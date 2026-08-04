# Approval agent

This executable example models the full approval boundary for a simulated outbound message. Its CLI prints only the canonical preview; the challenge is passed directly to the command and is never printed.

```sh
pnpm --filter pactmark-example-approval-agent test
pnpm --filter pactmark-example-approval-agent typecheck
pnpm --filter pactmark-example-approval-agent build
pnpm --filter pactmark-example-approval-agent dev
```

The receiver is in memory. Crash scenarios and reconciliation prove idempotency behavior, not delivery by a real provider or transactionally isolated production execution.
