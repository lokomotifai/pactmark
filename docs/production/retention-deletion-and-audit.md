---
title: Retention, deletion, and audit
description: Operate separate records with explicit purpose, access, and lifecycle.
---

> Compatibility: Pactmark 0.2.x.

Define retention independently for events, commands, work orders, protected context,
inputs, effect ledgers, approvals, artifacts, verification, evidence, audit, logs,
telemetry, projections, replicas, and backups. Append-only run truth does not mean
indefinite retention.

Deletion must be tenant-scoped, authorized, idempotent, and observable. Rebuild or
remove projections after source deletion. Track backup expiry and legal holds without
claiming immediate erasure where the storage system cannot provide it.

Audit records describe authority and decisions. They are not application logs or
hidden reasoning. Restrict exports and verify redaction before downstream ingestion.
