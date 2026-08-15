---
"@pactmark/core": minor
"@pactmark/policy": minor
"@pactmark/runtime": minor
"@pactmark/agent": minor
"@pactmark/evidence": minor
"@pactmark/http": minor
"@pactmark/mcp": minor
"create-pactmark": patch
---

Make host-derived tool resources authoritative, enforce complete policy preflight on every tool
dispatch, and fail unknown resource kinds closed.

Harden HTTP development authentication/readiness, add portable evidence signatures, consolidate MCP
SSRF controls with active DNS validation, pin preview executable identity through launch, improve
credential/redaction/secret-audit boundaries, and generate authenticated starter hosts.
