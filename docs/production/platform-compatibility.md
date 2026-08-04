---
title: Platform compatibility
description: Distinguish locally tested hosts from experimental and unverified deployments.
---

> Compatibility: Pactmark 0.1.x.

| Target                 | Status                     | Evidence boundary                               |
| ---------------------- | -------------------------- | ----------------------------------------------- |
| Node 22 macOS arm64    | Locally build-compatible   | Full clean-source aggregate                     |
| Node 22/24 Linux arm64 | Locally build-compatible   | Offline portable-host matrix                    |
| Node 24 macOS/Windows  | Untested                   | Workflow definition is not runtime evidence     |
| Node OCI               | Locally build-compatible   | Network-disabled build and bounded local run    |
| Next/Vercel adapter    | Locally build-compatible   | Build, route, security, accessibility contracts |
| Vercel live            | Unsupported until verified | No authorized deployment evidence               |
| Cloudflare Worker      | Experimental               | Types and Wrangler dry-run only                 |
| Memory store           | Development only           | Deterministic but ephemeral                     |
| PostgreSQL 17          | Locally build-compatible   | Migrations, concurrency, TLS, crash/resume      |

Consult the mutable readiness record for exact digests and timestamps. Do not infer
support for an OS, architecture, provider, database service, or deployment from
source-code appearance.
