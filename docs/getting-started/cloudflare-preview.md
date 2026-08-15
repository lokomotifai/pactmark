---
title: Cloudflare Worker preview
description: Use the experimental portable subset without assuming Node capabilities.
---

> Compatibility: Pactmark 0.2.x. Status: **experimental**.

`@pactmark/cloudflare` exposes the Web-standard HTTP subset. Portable core packages
avoid Node built-ins, environment reads, and provider SDKs. The example passes type
generation, Wrangler dry-run, and a live experimental staging check. The staging
Worker returned health 200, completed one deterministic SSE fixture, and honestly
returned readiness 503 because its memory-backed runtime is not durable or
production-isolated.

Do not select Node-only executors, stdio MCP, local filesystem assumptions, or the
Postgres worker inside a Worker. Provide platform-supported persistence and egress
adapters explicitly. Unsupported capability metadata fails closed.

The public staging URL and exact deployment evidence are recorded in the mutable
v0.1 readiness record. Do not send secrets or customer data to that anonymous,
ephemeral fixture.
