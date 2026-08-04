---
title: Node and OCI container
description: Run the Node adapter directly or in the bounded reference container.
---

> Compatibility: Pactmark 0.1.x. The reference image is locally build-compatible,
> not published or production-certified.

`@pactmark/node` bridges the Web handler to `node:http`, exposes health/readiness,
handles `SIGTERM`, and can run beside the Postgres worker. The OCI fixture builds
with network disabled and runs as a non-root user with a read-only filesystem.

## Development profile

The memory profile is deterministic and tenant-scoped but ephemeral. Readiness
honestly reports not ready for durable production work.

## Durable profile

Use Postgres migrations, hostname-verified TLS, least-privilege roles, fenced
leases, protected context storage, backups, and a separately operated worker.

## Recovery

On termination, stop accepting work, release or allow leases to expire, and resume
from persisted events in a later process. Never repeat an uncertain external effect
unless its registered strategy proves that retry is safe.
