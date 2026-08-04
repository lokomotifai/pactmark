---
title: Security model
description: Enforce default-deny authority outside model context and fail closed on uncertainty.
---

> Compatibility: Pactmark 0.1.x.

The model is never authority. Authentication, tenant binding, policy, grants,
approvals, budgets, schema validation, credentials, egress, verification, and effect
execution stay in host-controlled ports. Unknown metadata or capability fails closed.

Resolved model and tool credentials never enter model context, events, artifacts,
evidence, telemetry, or ordinary diagnostics. Every storage access includes tenant
identity. Append-only events are run truth; projections are disposable caches.

External effects use explicit strategies and an effect ledger. An uncertain outcome
is not retried without proof. This design reduces risk but does not establish complete
security, production isolation, compliance, or certification.
