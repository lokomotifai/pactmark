# Changelog

All notable changes to Pactmark will be documented here.

The project follows [Semantic Versioning](https://semver.org/) and uses
Changesets to prepare release notes and coordinated package versions.

## Unreleased

### Added

- `@pactmark/ai-sdk` now advertises an agent's tools to AI SDK v7 providers as
  schema-only definitions and maps provider tool calls to governed `tool_call`
  proposals; the host still revalidates every proposed input and target before
  policy and dispatch. Omitted model profiles compile to explicit
  `unreviewed-local-preview` claims.
- `@pactmark/agent` accepts raw Zod schemas, string instructions, a default
  deny-everything R0/R1 policy, and default verifiers; `createLocalRuntime`
  gains an optional local authority issuer and a `run()` convenience for the
  ephemeral profile. Defaulted definitions produce byte-identical registration
  digests to their explicit equivalents.
- Facade `defineTool` supports governed R2 write operations dispatched through
  deterministic previews, one-use capability grants, bound authorization, and
  the effect ledger; R3+ still requires kernel-level composition.
- `examples/quickstart-agent` demonstrates the ~30-line agent surface with a
  provider-shaped deterministic model and one governed R2 write.

### Changed

- The `@pactmark/ai-sdk` exact `ai@7.0.48` guard became a tested-range guard
  (`>=7.0.48 <8`); the installed version is recorded in the adapter
  registration digest.

### Fixed

- `validateEffectExecution` no longer rejects kind-`none` effect strategies:
  the canonical acknowledgement comparison omits an absent operation key
  instead of serializing undefined.

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
