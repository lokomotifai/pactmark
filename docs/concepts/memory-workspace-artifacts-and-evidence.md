---
title: Memory, workspace, artifacts, and evidence
description: Distinguish operational context from deliverables and bounded claims.
---

> Compatibility: Pactmark 0.2.x.

Memory and `ContextStore` data support execution and resume. They are not an audit
log and may contain only admitted, purpose-bound context. Workspaces are capabilities
with normalized paths, size limits, and explicit export boundaries.

An `Artifact` is content-addressed output. Verification binds the exact artifact,
verifier registration, rubric, and result. An `EvidenceRecord` summarizes selected
events and claims after redaction; it is not hidden chain-of-thought.

Evidence proves only the named checks over the named bytes and environment. It does
not prove truth, security, regulatory compliance, or fitness outside that scope.
