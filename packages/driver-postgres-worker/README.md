# `@pactmark/driver-postgres-worker`

Durable-worker contracts, a concrete PostgreSQL queue, and a bounded, fenced polling loop for a PostgreSQL-backed Pactmark host.

The package does not open a database connection by itself. A host can inject its
transaction-capable PostgreSQL client into `DurablePostgresWorkerQueue`; the
minimal interface deliberately has no dependency on `@pactmark/store-postgres`.
Each claim transaction uses database time and `FOR UPDATE SKIP LOCKED`, acquires
or advances the run lease/fencing token, and binds the wakeup to the immutable
tenant/run WorkOrder record. Renew, complete, release, and stale recovery match
the exact receipt, request digest, lease ID, holder, and fence. Stale or replayed
receipts therefore fail closed.

Claims reconstruct only the narrowed worker metadata persisted by migration
`007`: principal identity, purpose registry version, resource-scope ceiling,
execution-definition digest, and the durable request. WorkOrder goal, input,
challenge proof, credentials, and hidden reasoning are never loaded into the
claim. Request and execution-definition digests are rechecked before dispatch.
Grant authority is not cached in the queue and must still be verified at the
runtime boundary immediately before an effect.

`PostgresRunWorker.runOnce()` recovers stale claims, claims at most the configured concurrency, issues a run-scoped delegated authority, verifies it immediately before dispatch, and records completion or a bounded retry. Human-decision states are parked by the injected `RunDriver`; the worker cannot manufacture decision rights.

Production readiness additionally requires the queue implementation, command unit of work, and wake-up outbox to share the same PostgreSQL transaction domain. This package alone is not evidence that a host satisfies that requirement.

## Tests

The unit suite includes stateful SQL-boundary races. The integration suite must
be pointed at a disposable real PostgreSQL database and proves competing claims,
stale recovery, monotonically increasing fences, stale completion rejection,
parked completion, and reconstruction after a new queue instance:

```sh
pnpm --filter @pactmark/driver-postgres-worker test

PACTMARK_TEST_POSTGRES_URL='postgresql://…' \
pnpm --filter @pactmark/driver-postgres-worker test:integration
```
