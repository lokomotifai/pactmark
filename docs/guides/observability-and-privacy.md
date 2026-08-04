---
title: Observability and privacy
description: Emit operational metadata without exporting model or secret content.
---

> Compatibility: Pactmark 0.1.x.

Pactmark telemetry is opt-in and metadata-only by default. Record stable event type,
duration, bounded counts, status, and opaque digests. Do not record prompts,
completions, workspace bodies, tool arguments/results, credentials, challenge proofs,
protected context, or hidden reasoning.

Keep application logs, audit records, work state, telemetry, and evidence as distinct
outputs with separate access and retention. Redaction is enforced before export, not
left to dashboard configuration. Verify deletion across primary, replica, backup,
artifact, and telemetry systems.
