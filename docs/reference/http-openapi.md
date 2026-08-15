---
title: HTTP and OpenAPI reference
description: Expose authenticated JSON commands, SSE progress, and readiness contracts.
---

> Compatibility: Pactmark 0.2.x.

`@pactmark/http` implements Web-standard handlers for start, resume, inspect, events,
input, decisions, cancellation, health, and readiness. Host authentication resolves
tenant and principal; clients provide bounded command IDs and validated payloads.

Errors use Problem Details with stable `KAF_*` codes. SSE supports sequence replay
and bounded tailing. CORS, credential mode, CSRF, request/body/time limits, admission,
and disclosure behavior are host configuration.

The generated OpenAPI document is runtime-derived. Treat it as the signature source
instead of copying request fields into unrelated documentation.
