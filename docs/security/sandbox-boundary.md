---
title: Sandbox boundary
description: Understand why the reference container is a test fixture, not production isolation.
---

> Compatibility: Pactmark 0.2.x. Status: **unsafe reference fixture**.

The container conformance fixture uses a non-root user, no network, read-only root,
tmpfs workspace, no mounts or Docker socket, dropped capabilities, no-new-privileges,
and process, memory, CPU, time, and output limits. It exercises traversal, symlink,
secret, socket, loopback, metadata, fork, loop, and output probes.

These controls do not prove resistance to kernel, runtime, container-engine, side
channel, or multi-tenant attacks. Production arbitrary-code execution requires a
separately selected and independently assessed isolation system. Without that adapter,
untrusted stdio MCP and arbitrary code remain unsupported.
