---
title: Build your first agent
description: Create and run a deterministic Pactmark agent without a model key.
---

> Compatibility: Pactmark 0.2.x. Version 0.2.0 is the current verified public release.

## Current published release path

Run `npm create pactmark@latest -- my-agent`, change to `my-agent`, and run
`npm run dev`. `latest` resolves to the independently byte-verified v0.2.0 public
release. Pin exact versions in controlled environments.

Expected progress is `RunAccepted`, `ToolCallCompleted`, then `RunCompleted`. The
generated project uses a deterministic local model and needs no API key.

## Agent source

The site imports this source directly from the compiled example fixture:

<!-- pactmark:snippet source=examples/minimal-tool-agent/src/example.ts language=ts -->

## Local candidate verification

Contributors run `pnpm test:loopback-registry`. It packs all candidates, publishes
them dependency-first to an ephemeral loopback registry, executes the initializer,
and leaves global npm configuration unchanged.

## Recovery

If installation returns not found, verify the configured registry, network access,
and requested version. Do not switch to an unverified lookalike package. For a run
failure, inspect the stable `KAF_*` code and the run event stream; never parse the
English error text as an API.
