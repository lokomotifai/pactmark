---
title: Vercel deployment
description: Wire the Pactmark Next adapter while keeping durable state outside an invocation.
---

> Compatibility: Pactmark 0.2.x. Local adapter evidence is available; no live
> Pactmark Vercel deployment has been verified.

## Architecture

Use `@pactmark/vercel` as a thin Web-standard route adapter. Authentication resolves
the principal and tenant before runtime access. Production durability requires a
hostname-verified TLS Postgres store and the durable worker/scheduler profile.

## Build and preview

The local `nextjs-vercel` fixture builds routes, checks accessibility and security,
and exercises streamed events. A release preview must install the exact attested
tarballs from a vendored frozen lockfile; it must not resolve Pactmark packages from
the public registry before publication.

## Limits

A long function timeout is not a durability guarantee. Memory state, background
work inferred from an open response, or an unauthenticated preview cannot satisfy
the production gate. Live deployment remains unsupported until the readiness record
contains URL, log, database-resume, rollback, and teardown evidence.
