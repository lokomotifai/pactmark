---
title: Approval integration
description: Implement authenticated, exact, expiring human decision flows.
---

> Compatibility: Pactmark 0.2.x.

Present a human with normalized effect preview, scope, risk, target, cost bounds, and
the exact policy/grant identities. Issue a one-use challenge only after current
authentication. Submit the opaque proof directly; never copy it into a model prompt,
URL, log, or evidence record.

The runtime atomically consumes the decision with authorization and credential
reservations. Same-command replay returns the same semantic result. Different
bindings conflict and expired, revoked, cross-tenant, or wrong-role decisions dispatch
nothing.
