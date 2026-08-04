---
title: Cloudflare Worker preview
description: Use the experimental portable subset without assuming Node capabilities.
---

> Compatibility: Pactmark 0.1.x. Status: **experimental**.

`@pactmark/cloudflare` exposes the Web-standard HTTP subset. Portable core packages
avoid Node built-ins, environment reads, and provider SDKs. The example passes type
generation and Wrangler dry-run, but no staging deployment has been inspected.

Do not select Node-only executors, stdio MCP, local filesystem assumptions, or the
Postgres worker inside a Worker. Provide platform-supported persistence and egress
adapters explicitly. Unsupported capability metadata fails closed.
