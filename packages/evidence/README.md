# @pactmark/evidence

Evidence-native utilities for Pactmark: content-addressed artifacts, deterministic and explicitly non-deterministic verifier results, referentially checked evidence records, source-side redaction, stable JSON/Markdown export, and guarded pattern maturity.

The package is provider-neutral. Verification proves only the declared verifier/rubric result against an exact artifact digest; citation shape does not prove source truth, and model assessment is never sufficient by itself for high-risk completion.

`buildEvidenceRecord` recomputes artifact, execution-definition, verification, exception, and evidence digests and requires exact matching run events plus declared verifier/rubric identities. Human results require an identified reviewer. A verification exception is short-lived and scoped to one tenant, run, artifact, verifier registration, and rubric; its identifier must be disclosed in both `supports` and `doesNotProve`, it cannot replace a recorded failure, and it is never sufficient by itself for high-risk completion.

`createEvidenceExport`, `exportRedactedEvidenceJson`, and `exportRedactedEvidenceMarkdown` apply an allowlisted set of typed redactions before serialization and emit a deterministic export digest. Evidence and telemetry are separate concerns: telemetry may remain disabled while a host creates required local evidence. This package does not provide or claim durable evidence storage; the host controls evidence persistence, access, retention, and deletion through its own storage policy.

Version `0.1.1` is public on npm with verified registry bytes and provenance. This
release status does not establish durable evidence storage or expand the
verification claims above.
