---
title: Pactmark documentation
description: Build bounded agents that produce artifacts, verification, and evidence.
template: splash
hero:
  tagline: Evidence-native TypeScript agents with authority outside the model.
  actions:
    - text: Build a first agent
      link: /pactmark/en/getting-started/first-agent
      icon: right-arrow
    - text: Read the security model
      link: /pactmark/en/security/security-model
      variant: minimal
---

> Compatibility: Pactmark 0.2.x. Version 0.2.0 is public on npm with verified
> registry bytes and per-package provenance.

Pactmark turns a validated `WorkOrder` into a bounded run, governed tool effects,
verified artifacts, and an `EvidenceRecord`. Policy, credentials, approvals,
budgets, storage, and effect execution remain outside model authority.

Local conformance covers deterministic models, memory and Postgres profiles,
Node/OCI, Next/Vercel contracts, and an experimental Cloudflare subset. It does
not prove a live deployment, universal effect exactly-once behavior, certification,
or production isolation.
