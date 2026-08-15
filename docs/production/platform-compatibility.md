---
title: Platform compatibility
description: Distinguish locally tested hosts from experimental and unverified deployments.
---

> Compatibility: Pactmark 0.2.x.

| Target                 | Status                        | Evidence boundary                                                                |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Node 22 macOS arm64    | Locally build-compatible      | Full clean-source aggregate                                                      |
| Node 22/24 Linux arm64 | Build-compatible              | Offline portable-host matrix and protected CI                                    |
| Node 24 macOS/Windows  | Build-compatible              | Protected host CI matrix                                                         |
| Node OCI               | Locally build-compatible      | Network-disabled build and bounded local run                                     |
| Next/Vercel adapter    | Locally build-compatible      | Build, route, security, accessibility contracts                                  |
| Vercel live            | No current deployment         | Historical test-only Preview evidence; retained resources were removed           |
| Cloudflare Worker      | Staging-verified experimental | Live health, error routing, fail-closed readiness, and deterministic SSE fixture |
| Memory store           | Development only              | Deterministic but ephemeral                                                      |
| PostgreSQL 17          | Locally build-compatible      | Migrations, concurrency, TLS, crash/resume                                       |

Consult the mutable readiness record for exact digests and timestamps. Do not infer
support for an OS, architecture, provider, database service, or production
deployment from source-code appearance. The Cloudflare staging result remains
anonymous-development, memory-backed, and explicitly non-production.
