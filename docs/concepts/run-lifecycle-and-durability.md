---
title: Run lifecycle and durability
description: Understand append-only run truth, projections, suspension, and safe resume.
---

> Compatibility: Pactmark 0.1.x.

Validated commands append versioned `RunEvent` records. A projection is a rebuildable
cache, not the source of truth. Runs move through accepted, running, waiting,
verifying, and terminal states; invalid and post-terminal transitions fail.

Durable Postgres commands bind idempotency, authority, event mutation, and wake-up
state. Fenced leases prevent a stale worker from committing after ownership loss.
Protected context is tenant-scoped and purpose-bound.

Pactmark uses at-least-once execution with controlled effects. It does not claim
global exactly-once delivery. An uncertain effect stays parked until its registered
native, transactional, reconcilable, compensatable, or none strategy permits action.
