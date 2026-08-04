# ADR-0006: Artifacts, verification, evidence, and reuse maturity

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Pactmark maintainers

## Context

A completed run, fluent answer, or positive evaluation does not by itself show
that an output is correct, reusable, current, or authorized. Evidence needs to
remain inspectable without exposing operational context or implying more than
the underlying observations support.

## Decision

Pactmark separates four concepts:

1. An `Artifact` is a content-addressed output with media type, owner,
   visibility, data class, retention, provenance, and producing run/step.
2. A `VerificationResult` is the versioned output of a deterministic,
   model-based, or human verifier against one exact artifact digest.
3. An `EvidenceRecord` states a bounded claim, its supporting artifacts,
   events, and verifications, its permission/freshness context, and explicit
   non-claims.
4. A `PatternManifest` describes a reusable asset at an exact
   `roleFamily x workflowId x riskClass` scale and maturity stage.

Evidence is derived from typed records, never chain of thought or raw hidden
context. Content identity uses validated, schema-normalized data serialized as
RFC 8785 JSON Canonicalization Scheme, UTF-8, and lowercase algorithm-tagged
SHA-256 (`sha256:<64-hex>`). Binary artifacts hash exact bytes; text
normalization occurs only when an enclosing schema explicitly declares it.

One successful run cannot establish a proven reusable pattern. Promotion
requires repeated, independent evidence meeting versioned thresholds for the
declared scale unit, with failures and negative evidence retained. Evidence
quality, adoption, autonomy, work transformation, and outcome are reported as
separate dimensions.

Evidence access never widens underlying artifact, tenant, or data permissions.
Freshness, verifier versions, registration digests, and known limits travel
with claims. A record may support “artifact matched schema under verifier X at
time Y”; it must not silently become “the work is correct” or a business-impact
claim.

## Consequences

- Artifact and evidence stores enforce tenant, visibility, retention, and
  deletion independently of run context storage.
- Verifiers are registered and identity-digested; changing their schemas,
  rubric, executor, or implementation changes their identity.
- Evidence exports must be deterministic, permission-checked, and explicit
  about missing or stale inputs.
- Pattern promotion requires repeated-use fixtures, failure cases, and
  threshold tests.
- Human verification remains attributable and cannot be forged from a model
  assertion.

## Rejected alternatives

- **Run success equals evidence:** conflates execution state with output truth.
- **One evaluation score:** hides incomparable dimensions and uncertainty.
- **Copy operational context into evidence:** violates purpose limitation and
  expands sensitive-data exposure.
