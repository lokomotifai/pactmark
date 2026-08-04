---
title: Reliability and recovery
description: Design for at-least-once work, fenced ownership, and explicit uncertain outcomes.
---

> Compatibility: Pactmark 0.1.x.

Use durable command records, append-only events, transactional wake-ups, database-time
leases, fencing tokens, bounded retries, deadlines, cancellation, and pessimistic
reservations. Monitor active and parked work rather than assuming an HTTP request owns
the complete lifecycle.

Recovery starts from persisted truth in a fresh process. Rebuild projections and
reload protected context by tenant and purpose. For external effects, follow only the
registered strategy; never retry solely because a response was lost.

Set RPO/RTO from the deployed database, artifact, key, and backup systems. Local
Postgres crash tests are design evidence, not a promise for an operator's topology.
