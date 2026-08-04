---
title: PostgreSQL durable profile
description: Configure tenant-scoped event truth, protected context, and fenced workers.
---

> Compatibility: Pactmark 0.1.x. Local evidence uses disposable PostgreSQL 17.

Apply ordered migrations with the Pactmark migration manager, use a least-privilege
role, and require hostname-verified TLS. Every storage path includes tenant identity.
Events are append-only truth; projections can be rebuilt.

The worker claims wake-ups with database-time leases and fencing tokens. Atomic
commands bind idempotency records, authority, events, reservations, and wake-ups.
Large protected references use bounded authenticated digests for uniqueness while
retaining ciphertext for read verification.

Back up events, work orders, command records, effect ledgers, artifacts, protected
stores, and migration state together. Test restore and cross-process resume before
assigning production RPO or RTO values.
