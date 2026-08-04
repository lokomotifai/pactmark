---
title: Verification and evals
description: Bind deterministic checks and model-assisted evals to exact artifacts.
---

> Compatibility: Pactmark 0.1.x.

A `Verifier` returns a versioned `VerificationResult` for an exact artifact digest.
Deterministic schema, checksum, policy, and custom checks run without a model key.
Model-assisted evals use the same admitted model and credential boundaries and must
record their limitations.

Passing verification allows the configured run transition; it does not convert a
probabilistic judgement into fact. A verification exception may address only a
finding explicitly marked exception-eligible and cannot waive security controls.
