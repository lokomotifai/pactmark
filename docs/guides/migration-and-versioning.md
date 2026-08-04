---
title: Migration and versioning
description: Evolve wire contracts, registrations, packages, and database state safely.
---

> Compatibility: Pactmark 0.1.x.

Public and persisted contracts carry schema versions and reject unknown future
versions. Package releases use SemVer and Changesets. Exact internal package versions
share one release version for v0.1.

Changing schema semantics, policy, verifier, tool, model factory, security profile,
or effect strategy requires an identity or implementation-version change. Active
runs suspend rather than resume against drifted registrations.

Database migrations are ordered and forward-applied. Test a representative upgrade,
projection rebuild, rollback plan, backup restore, and old-run inspection before
production rollout.
