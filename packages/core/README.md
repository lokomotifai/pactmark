# @pactmark/core

Provider-neutral domain schemas, event contracts, pure reducers, stable errors, and dependency-injection ports for Pactmark.

This package contains no model-provider, platform, database, Node built-in, or environment dependency. External and persisted input is accepted as `unknown` and validated at runtime. Public wire objects carry explicit schema versions and use stable `KAF_*` errors.

Evidence persistence uses the portable `EvidenceRecordStore`,
`VerificationRecordStore`, and `PatternRecordStore` ports. Verification and
pattern records include explicit tenant, purpose, and data-class routing around
their immutable result/manifest. Concrete memory and PostgreSQL behavior remains
in the corresponding storage adapters.

The package is not yet publicly released. Local development and packed-candidate behavior are governed by the repository PLAN and readiness record.
