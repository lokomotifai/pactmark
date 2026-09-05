---
"@pactmark/agent": minor
"@pactmark/ai-sdk": patch
"@pactmark/cli": patch
"@pactmark/core": minor
"@pactmark/driver-postgres-worker": patch
"@pactmark/evidence": patch
"@pactmark/executor-in-process": patch
"@pactmark/http": patch
"@pactmark/mcp": minor
"@pactmark/policy": minor
"@pactmark/runtime": minor
"@pactmark/store-memory": minor
"@pactmark/store-postgres": minor
"create-pactmark": patch
---

Fail closed for implicit PostgreSQL tenant and purpose scope, bind tenant RLS
inside store transactions, and add durable opaque `SecretRef` metadata storage.

Enforce model, MCP server, and compensation kill switches at their execution
boundaries, and replace dead error-documentation links with the versioned public
error reference.

Enforce delegated run scope at the runtime authorization boundary, including
exact run/work-order binding, worker operation limits, and replay-path checks.

Validate production WorkOrder input against the exact compiled agent schema
before kernel admission while preserving the caller's raw command digest.

Park interrupted native effects unless replay safety is independently proven,
bind durable strategy and operation keys before recovery, validate
reconciliation results, and record every proven-safe redispatch attempt.

Record deterministic, run-owned model, tool, policy, effect, verification, and
evidence failures as terminal `RunFailed` events with stable KAF codes; park
uncertain boundary outcomes, preserve recoverable infrastructure failures, and
retain local background failures until `wait()` observes them. Runtime-validate
policy decisions, retry classifications, verifier results, and bound evidence
records before they can authorize work or complete a run.

Split protected-record expiry into tenant-scoped store methods and an explicit
operator-only PostgreSQL maintenance boundary. Deprecated ambiguous global
purges now fail closed, while a real non-owner role test proves unset and
cross-tenant RLS denial and preserves deliberate owner-only global maintenance.
Retain immutable run and wakeup identity bindings independently of protected
WorkOrder rows so expiry can delete a referenced WorkOrder without weakening
new-binding validation.

Align canonical JSON number parsing with serialization, qualify in-process
cancellation and authorization claims by tenant, and map malformed HTTP input
through the stable wire error contract.

Accept schema-less text MCP results while pinning schema presence and identity,
and surface AI SDK stream provider errors and aborts even when no tools are
registered.

Hosts upgrading MCP schema-absent tool pins must regenerate them with
`mcpToolOutputSchemaDigest(undefined)`; legacy implicit-object digests now fail
closed as schema drift.

Consume authorization reservations atomically with prepared effects while
retaining resume compatibility for lifecycle-consistent v0.2 records. Deprecate
unused host egress and model-target hints, derive authoritative targets inside
the runtime, and report only credential capabilities backed by a real boundary.

Tenant-qualify process-local grant, authorization-reservation, credential-use,
and uncertain-model-call identities. The authorization reservation reference
store's maximum-use callbacks now receive `tenantId` before the subject ID.

Make local R4 approval an explicit facade feature: preserve
`require_approval`, issue process-local command-idempotent challenges, bind the
recorded approval to the exact decision/tool/arguments/target/preview, claim it
atomically with the effect, and resume without double-counting the pending tool
call. Memory approval claims are tenant-qualified, one-use, replay-safe, and
transactionally rolled back. The Next.js fixture and approval-purchase example
exercise approve, reject, and explicit-resume paths without persisting the raw
challenge proof. R3 compensation and R5 production-grade user presence remain
explicit host-composition boundaries.

Bind every facade tool to its own declared egress broker so an approved tool
cannot borrow a sibling tool's origin or HTTP method. Treat the Next.js static
bearer fixture as single-factor authority so it cannot satisfy R4 approval.

Bind the human-readable approval display into the exact preview digest and
render the requested item in the Next.js approval surface. Preview producers
must keep secrets out of this display. Durable workers now conservatively
report single-factor authority instead of manufacturing phishing-resistant
human-auth strength from a lease and scheduler receipt.

Derive CLI, HTTP, AI SDK adapter, MCP client, and in-process executor versions
from their package manifests. Make deterministic advisory evidence immutable
and lockfile-bound without wall-clock expiry, scan package sources with Knip,
repair and self-test the release placeholder gate, remove unused size tooling,
parameterize protected release workflows with a package-verified version, and
declare API Extractor's CRLF reports as CR-aware for stable whitespace checks.

Restrict `RunFailed.errorCode` to the public KAF error registry. Generated
starters now execute a real governed R1 read tool, the portable example derives
its contract from an actual runtime event trail, and the quickstart exposes an
explicitly opt-in live-provider smoke path that remains outside required CI.
Publish a self-contained local security-document index, clarify PostgreSQL
record-level deletion semantics, and restore English/Turkish safety parity.
