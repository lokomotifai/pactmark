---
title: Responsibility matrix
description: Separate Pactmark controls from host, operator, provider, and application duties.
---

> Compatibility: Pactmark 0.1.x.

| Area       | Pactmark provides                        | Operator or application owns                                      |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------- |
| Identity   | Authority schemas and enforcement ports  | Identity provider, authentication, role mapping, revocation       |
| Tenancy    | Tenant-bound contracts and tested stores | Tenant lifecycle, authorization data, isolation review            |
| Models     | Adapter and budget boundaries            | Provider contract, region, data policy, credentials, model choice |
| Tools      | Policy, grants, approvals, effect ledger | Tool implementation, target safety, credentials, reconciliation   |
| Durability | Postgres adapter, events, leases, worker | Database service, backups, HA, TLS, capacity, RPO/RTO             |
| Artifacts  | Content addressing and verifier binding  | Artifact truth, retention, access, downstream use                 |
| Operations | Health/readiness and incident primitives | Monitoring, on-call, rollout, rollback, incident response         |

No row transfers legal, regulatory, security, or availability responsibility to a
framework test result.
