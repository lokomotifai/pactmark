# @pactmark/vercel

## 0.2.0

### Minor Changes

- 1f2b553: Make host-derived tool resources authoritative, enforce complete policy preflight on every tool
  dispatch, and fail unknown resource kinds closed.

  Harden HTTP development authentication/readiness, add portable evidence signatures, consolidate MCP
  SSRF controls with active DNS validation, pin preview executable identity through launch, improve
  credential/redaction/secret-audit boundaries, and generate authenticated starter hosts.

  Apply the same coordinated minor version to the complete public package surface so every packed
  internal dependency remains exact and every changed adapter, store, host bridge, and initializer is
  identified by the release version that contains the hardened behavior.

### Patch Changes

- Updated dependencies [1f2b553]
  - @pactmark/http@0.2.0
