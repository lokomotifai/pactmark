# Delegated incident and resume boundary

This deterministic example proves the public worker authority issuer binds a
system worker to one run, scheduler receipt, lease, and fencing token, and that
a newer fence invalidates the old delegation. It does **not** claim durable
resume: the public Postgres suite currently lacks a concrete
`RunCommandUnitOfWork` and wakeup queue/scheduler, and the runtime lacks the
effect acknowledgement path required for the crash/resume acceptance scenario.

```sh
pnpm --filter pactmark-example-delegated-incident test
pnpm --filter pactmark-example-delegated-incident dev
```

Until those public ports have concrete durable implementations, a fresh-process
resume example must fail closed instead of simulating success.
