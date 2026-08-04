# `@pactmark/store-memory`

Deterministic, tenant-scoped Pactmark stores for tests, local development, and explicitly ephemeral demos.

This adapter is **not durable**. Process exit discards every record, lease, event, projection, and artifact. Its capabilities always report `executionProfile: "ephemeral"` and `durableStorage: false`; it cannot satisfy durable or production readiness.

The default storage security profile accepts only `public` and `internal` data. A caller may configure additional tenant, purpose, and data-class allowlists. Confidential or restricted WorkOrders and artifact bodies additionally require an injected `DataProtector`; the memory store retains only the returned protected reference. `highly_restricted` data is always rejected.

```ts
import { createMemoryStoreSuite } from "@pactmark/store-memory";

const stores = createMemoryStoreSuite();
await stores.eventStore.append(runAcceptedEvent, 0);
```

The suite also provides a process-local `runCommandUnitOfWork`. It scopes command replay to issuer, tenant, authenticated principal, operation, normalized resources, and command ID; conflicting request digests fail closed. It serializes callbacks in one process but deliberately reports `atomicCommandAndWakeup: false`, does not survive restart, and cannot prove production durability.

The suite's `effectLedger` is the matching process-local read model for runtime
effects and authorization reservations. The unit of work validates their exact
tenant/run/tool/arguments/target bindings, effect digest, unique effect and
operation keys, and legal effect-state transitions. A callback failure restores
both ledger maps before the next serialized transaction can observe them.

Acknowledged effect results must be protected by the runtime before entering the
unit of work. The transaction binds the protected record to the authoritative
accepted WorkOrder, effect digest, execution definition, tool and effect
strategy registrations, purpose, DataClass, plaintext byte size, and result
digest. It commits the acknowledged effect and protected result atomically. The
memory store retains only the protected reference, treats a replay with fresh
ciphertext for the same semantic result as idempotent without replacing the
first record, and validates the complete AAD, canonical JSON, byte size, and
digest on read. Protected-reference uniqueness and every read remain
tenant-scoped. These guarantees are process-local and are lost on exit.

The same process-local transaction also covers admission, active-execution, and
model-call reservations. `quotaLimits` declares whether each ceiling aggregates
across the tenant or per principal. Exact command replay is idempotent, changed
replay fails closed, uncertain active execution is charged at its reserved
maximum, and circuit-breaker updates use compare-and-set with a fenced half-open
probe. These semantics are deterministic test support only; they do not make the
memory profile durable or production-ready.

The event store provides optimistic sequence checks, global event-ID deduplication, deterministic projections, and explicit projection rebuild. The lease store advances a fencing token whenever ownership is reacquired. Use `eventStore.appendFenced(...)` for a transition that must prove a currently active memory lease.

`evidenceRecordStore`, `verificationRecordStore`, and `patternRecordStore` keep
tenant-scoped immutable records. Exact replay is idempotent; a changed record at
the same route, an invalid embedded digest, or reuse of one digest at another
route fails with a storage conflict. Reads require tenant plus record identity,
or tenant plus digest. These stores have no update/delete API and remain
process-local only.

Retention is evaluated on reads and can be swept with each store's `purgeExpired()` method. Backup and restore are intentionally unsupported: use `@pactmark/store-postgres` for durable operation.
