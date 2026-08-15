---
title: MCP integration
description: Treat MCP servers and discovered metadata as untrusted adapter input.
---

> Compatibility: Pactmark 0.2.x.

`@pactmark/mcp` supports tested stdio and Streamable HTTP transports. Host
configuration pins server identity, protocol capabilities, schemas, transport
security, limits, and allowed tools. Discovery never grants authority.

HTTP uses an exact HTTPS origin through the egress broker, denies cross-origin
redirects, and binds credentials to the origin. Stdio requires an absolute executable,
fixed arguments, minimal environment, bounded output/time, and cleanup. Without a
production `SandboxAdapter`, stdio remains preview-only.

Malformed pages, duplicate tools, cursor loops, unknown risk, and schema drift fail
closed before a tool is exposed to the model.
