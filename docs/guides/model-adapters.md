---
title: Model adapters
description: Integrate providers without transferring authority to model code.
---

> Compatibility: Pactmark 0.1.x.

A model adapter normalizes streamed content, tool requests, finish reasons, usage,
and retry classification. Registration binds provider, model factory, security and
resource profiles, endpoint, implementation version, and source digest.

The runtime accepts a pessimistic model-call reservation before issuing a short-lived
`ModelCredentialRef`. The adapter resolves it only for the bound call. Credentials,
raw prompts, completions, and hidden reasoning stay out of ordinary telemetry and
evidence. Unsupported output caps or usage accounting fail before export.

`@pactmark/ai-sdk` demonstrates Vercel AI SDK integration. Deterministic test models
cover required behavior without a live provider key.
