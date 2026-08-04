---
title: Decisions and human authority
description: Bind human decisions to exact work, effects, and one-use proofs.
---

> Compatibility: Pactmark 0.1.x.

An `Approval` is not free-form text. A host issues a `DecisionChallenge` after
authenticating the actor, then atomically consumes its proof into a decision bound to
tenant, run, effect, policy, grant, scope, and expiry.

Approval cannot waive authentication, tenant isolation, missing grants, schema and
budget enforcement, secret boundaries, egress policy, or uncertain-effect rules.
Rejected and expired decisions produce zero effect dispatch.

Raw challenge proofs do not enter events, SSE, logs, context, artifacts, telemetry,
or evidence. Stable records retain only keyed digests and bindings.
