# Changelog

All notable changes to Pactmark will be documented here.

The project follows [Semantic Versioning](https://semver.org/) and uses
Changesets to prepare release notes and coordinated package versions.

## Unreleased

### Added

- The local facade now supports complete, process-local R4 approval: exact
  previews, one-use challenges and approvals, approve/reject, and explicit
  resume. R3 compensation and production R5 user presence remain host-owned.
- The approval-purchase example and explicit-preview Next.js fixture exercise
  real facade approval paths without persisting raw challenge proof.
- PostgreSQL has an operator-only global retention boundary and non-owner-role
  RLS coverage; ordinary expiry stays tenant-scoped.
- Generated starters execute a real governed R1 read tool, the portable example
  derives its claims from a real runtime trail, and the quickstart includes an
  explicitly opt-in live-provider smoke path.
- Public security documentation now has a self-contained local index and no
  longer requires access to a private documentation repository.

### Changed

- Delegated authority is bound to the exact run and WorkOrder. Production input
  is parsed by the selected agent's exact schema before admission.
- Native effects redispatch only when the registered strategy proves replay is
  safe; uncertain boundaries park for reconciliation.
- Canonical JSON, HTTP, MCP, AI SDK, cancellation, authorization reservation,
  tool-credential, and tenant-qualified storage boundaries now fail closed on
  malformed or mismatched state.
- Deterministic advisory evidence no longer expires by wall clock, but remains
  integrity-protected and bound to the exact lockfile. Protected release jobs
  still run a live network audit.
- CLI, HTTP, AI SDK adapter, MCP client, and in-process executor identities now
  derive their versions from checked-in package metadata.
- The coordinated Changesets group and protected release workflow now derive
  and verify one exact package version instead of embedding `0.2.0`.
- PostgreSQL's deletion capability now documents its record-level scope:
  lifecycle-managed protected records are deletable, while run truth and
  immutable evidence remain append-only.

### Fixed

- Runtime-owned failures now produce stable terminal or parked event truth
  instead of escaping with a nonterminal run.
- Local approval recovery requires the exact recorded decision, preview,
  arguments, target, principal, and approval ID before effect dispatch.
- Each facade tool gets its own egress broker; an approved R4 tool cannot borrow
  a sibling tool's origin or HTTP method.
- The Next.js static bearer fixture is single-factor and cannot satisfy R4
  phishing-resistant approval.
- Durable worker delegation no longer manufactures phishing-resistant human
  authentication strength from scheduler and lease metadata.
- `RunFailed` events reject error codes outside the public KAF registry.
- The placeholder gate now detects and self-tests unfinished, skipped, and
  focused markers across the tracked release surface. Knip now scans package
  sources, and unused size tooling was removed.
- Repository scanners ignore tracked paths deleted in the working tree, and
  generated API reports use CR-aware whitespace checks.

## 0.2.0 - 2026-08-15

### Changed

- Made host-derived tool targets and canonical resources authoritative before policy evaluation;
  model-provided target identity is no longer trusted.
- Strengthened grant, approval, effect, executor, tenant, credential, telemetry, HTTP, MCP, and
  PostgreSQL boundaries so unknown or mismatched runtime state fails closed.
- Added portable Ed25519 and P-256 evidence-attestation envelopes while preserving explicit
  self-attested evidence when a host does not provide verification authority.
- Hardened generated projects, loopback defaults, URL canonicalization, filesystem race handling,
  container profiles, packed-consumer verification, and release supply-chain workflows.
- Coordinated the complete 19-package public surface at version 0.2.0 so every packed internal
  dependency is exact and every hardened adapter is identified by the release version containing it.

### Security

- Added CodeQL, OpenSSF Scorecard, Dependabot, and scheduled Jazzer.js analysis with immutable
  workflow dependencies.
- Split release construction from the environment-protected OIDC publisher and verify the frozen
  candidate again before attestation and npm publication.
- Added tenant-aware worker admission and PostgreSQL row-level-security migration support. Runtime
  role configuration, storage encryption, and production deployment controls remain host-owned.

## 0.1.2 - 2026-08-14

### Changed

- Added the private, production-guarded Executor gateway integration and its digest-pinned self-host conformance evidence.
- Hardened fresh-checkout, Linux backup/restore, and Windows packed-initializer, packed-consumer, and repository-conformance CI behavior.
- Kept the public v0.1 runtime API and the 19-package npm surface unchanged.

## 0.1.1 - 2026-08-05

### Changed

- Re-established the public GitHub repository without the private planning artifact.
- Added token-free npm trusted-publishing execution for the existing guarded release workflow.
- Kept the v0.1 runtime API and behavior unchanged.

## 0.1.0 - 2026-08-05

### Added

- Initial repository governance, contribution, security, support, and
  architectural decision records.
- Initial 18 scoped packages and the unscoped `create-pactmark` initializer.
