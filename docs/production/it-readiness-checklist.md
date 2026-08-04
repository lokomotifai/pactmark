---
title: IT production readiness checklist
description: Record owners and evidence for identity, data, durability, recovery, and operations.
---

> Compatibility: Pactmark 0.1.x. A checked box is an operator decision backed by
> environment-specific evidence, not a Pactmark certification.

## Identity and tenancy

- Authenticate every command, stream, inspection, and decision path.
- Bind tenant and principal into every authority and storage access.
- Define authentication strength, role, grant issuance, revocation, and break-glass owners.

## Data and secrets

- Classify model, tool, workspace, artifact, context, audit, and telemetry data.
- Use hostname-verified TLS Postgres, least-privilege roles, encryption, and key rotation.
- Resolve `SecretRef` only inside the bound adapter; verify egress origins and regions.
- Set retention, deletion, backup, legal-hold, and evidence-export procedures.

## Reliability

- Run migrations, concurrency, cancellation, crash, lease-loss, and uncertain-effect tests.
- Set measured RPO and RTO targets; test backup restore and a later-process resume.
- Monitor wake-up lag, lease loss, parked runs, verification failures, and quota exhaustion.

## Operational decision

- Document shared responsibility and unsupported capabilities.
- Exercise credential leak and malicious MCP incident drills.
- Approve rollout, rollback, on-call, vulnerability response, and resource teardown.
