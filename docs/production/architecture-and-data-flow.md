---
title: Architecture and data flow
description: Trace authority, model export, effects, storage, artifacts, and evidence.
---

> Compatibility: Pactmark 0.2.x.

1. The host authenticates a principal and validates a `WorkOrder`.
2. Policy and admission reserve authority and budgets before mutation or export.
3. The runtime appends events and stores protected resumable context separately.
4. A model adapter receives only admitted context and a bound credential reference.
5. Tool requests return to policy; the executor resolves credentials and egress at dispatch.
6. Effects write preparation, acknowledgement, and reconciliation state around the boundary.
7. Artifacts enter content-addressed storage, then exact verifiers run.
8. Redacted evidence records selected claims and digests.

Trust boundaries exist at authentication, model export, MCP, egress, credentials,
external effects, Postgres, artifact storage, and telemetry. Deployment diagrams must
add the operator's actual network, region, key, backup, and identity systems.
