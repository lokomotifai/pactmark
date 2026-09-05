# Approval-bound purchase boundary

This executable example drives the published facade through an exact
process-local R4 decision boundary. The first execution parks before dispatch,
the host issues a one-use challenge, and the approving path records the bound
approval before an explicit resume performs exactly one simulated write. The
rejection path records `ApprovalRejected` and performs no write.

```sh
pnpm --filter pactmark-example-approval-purchase test
pnpm --filter pactmark-example-approval-purchase dev
```

The challenge proof stays in process-local memory and is never included in run
events. The example is still an ephemeral development fixture: it is not a
payment integration, durable approval service, or production-readiness claim.
