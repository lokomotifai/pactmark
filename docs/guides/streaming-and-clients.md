---
title: Streaming and clients
description: Consume bounded SSE progress with replay and authenticated inspection.
---

> Compatibility: Pactmark 0.1.x.

The HTTP adapter exposes typed JSON commands and SSE events. Clients retain the last
sequence and reconnect from that point; the store replays persisted events before
tailing new ones. Slow consumers are bounded and cannot require the runtime to retain
the complete stream in memory.

Authenticate every command and inspection request. Map idempotency keys into a
validated `CommandContext`. Treat disconnect as loss of transport, not cancellation
or proof that work stopped. Inspect terminal state through the authenticated run API.
