---
title: CLI reference
description: Use stable machine-readable commands for runs, inspection, evidence, and operations.
---

> Compatibility: Pactmark 0.2.x.

The `pactmark` binary is owned by `@pactmark/cli`. It provides run, inspect, doctor,
eval, evidence, migrate, reconciliation, and compensation surfaces through injected
host adapters. Commands validate unknown input and authority before mutation.

Use JSON output for automation and stable `KAF_*` codes for branching. Human text,
ordering outside the documented contract, and stack traces are not stable APIs.
Production doctor fails when required durability, sandbox, credentials, policy, or
registration evidence is absent.
