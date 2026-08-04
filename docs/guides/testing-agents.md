---
title: Testing agents
description: Test deterministic success, denial, interruption, concurrency, and drift.
---

> Compatibility: Pactmark 0.1.x.

Use `@pactmark/testing` for fake clocks, IDs, deterministic models, store contracts,
crash injection, and scenario construction. It is a development dependency and never
part of production exports.

Cover successful artifact production, malformed input, policy denial, grant and
approval replay, cancellation, budget exhaustion, concurrent commands, lease loss,
crash boundaries, uncertain effects, registration drift, and cross-tenant access.

Accept published behavior from packed tarballs in independent fixtures. Workspace
links alone cannot prove package metadata, exports, declarations, or initializer DX.
