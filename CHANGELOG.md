# Changelog

All notable changes to Pactmark will be documented here.

The project follows [Semantic Versioning](https://semver.org/) and uses
Changesets to prepare release notes and coordinated package versions.

## Unreleased

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
