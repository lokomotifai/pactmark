---
title: Tools, risk, and capability grants
description: Keep tool exposure and execution behind default-deny policy.
---

> Compatibility: Pactmark 0.1.x.

`ToolSecurity` classifies risk, scope, effect strategy, egress, credential mode, and
resource bounds. Unknown or unsupported metadata fails closed. Normalized schemas
and registration digests prevent a tool from silently changing under an old grant.

A `CapabilityGrant` binds tenant, principal, purpose, tool registration, scope,
expiry, and constraints. Policy rechecks current grants and kill switches before
every effect. One-use reservations close replay and concurrency gaps.

The model never sees authority objects or resolved secrets and cannot make a denied
tool available by changing instructions, metadata, or arguments.
