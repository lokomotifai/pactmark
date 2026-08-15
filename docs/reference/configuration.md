---
title: Configuration reference
description: Configure explicit ports, bounded profiles, and host-owned authority.
---

> Compatibility: Pactmark 0.2.x.

Pactmark configuration is constructor input, not ambient magic. Supply clocks, IDs,
stores, transaction boundaries, authority issuer, admission, policy, credentials,
models, tools, executor, egress, verifiers, evidence builder, telemetry, and wake-up
driver explicitly for the selected profile.

Development factories provide deterministic memory defaults and report their limits.
Production readiness rejects missing durability, atomicity, registered effect
strategies, bounded model resources, credential enforcement, or host capability.

Exact public signatures are generated on this site from committed API Extractor
reports. Stable behavior failures use `KAF_*` codes.
