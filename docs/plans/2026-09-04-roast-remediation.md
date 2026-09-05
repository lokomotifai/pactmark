# Plan: source-backed roast remediation

- **Status:** implementation complete; aggregate verification blocked on an
  explicitly authorized advisory refresh
- **Date:** 2026-09-04
- **Source tree:** `2d3968d980b019f14baf72b3b2e7e1eb1b581c88`
- **Scope owner:** maintainer-directed remediation
- **Safety rule:** findings are revalidated against source and tests before any
  change; rhetoric and severity labels are not treated as evidence.

## 1. Objective

Close the source-backed correctness, authorization, tenant-isolation, runtime,
API-boundary, and release-evidence gaps identified in the 2026-09-03 external
roast. Preserve Pactmark's fail-closed behavior, deterministic testability,
portable-kernel boundaries, stable public failures, and honest product claims.

This plan does not assume that every roast item is a defect. Each item ends as
one of:

- `fixed`: a reproduced defect is closed and verified;
- `no_change`: the current behavior is intentional and evidence supports it;
- `documented`: code is safe but the contract or claim was misleading;
- `blocked`: counsel, maintainer, provider, or compatibility evidence is needed.

## 2. Patch rules

1. Work in the dependency order below; do not bundle unrelated cleanup into a
   security fix.
2. For each security boundary, reproduce the unsafe path and a legitimate
   control before editing when feasible.
3. Add the smallest regression test that reaches the real boundary, not a
   string-only proxy.
4. Challenge every candidate patch for a sibling bypass and a legitimate-input
   regression before running the owning package checks.
5. Record only passed commands and observable proof in
   `docs/releases/v0.2-readiness.md`; unresolved work remains here.
6. Do not mutate the immutable CLA text, publish, deploy, push, or alter remote
   settings without the separately required authority.

## 3. Dependency-aware remediation sequence

### Phase 1 — delegated authority scope

Enforce `AuthorityClaims.runScope` in the runtime's shared authorization
boundary.

- A scoped authority cannot start a new run.
- A scoped authority can target only its exact `runId` and `workOrderId`.
- The worker delegation is limited to the operations its driver needs; target
  matching must not accidentally grant cancellation, approval, rejection,
  reconciliation, or compensation authority.
- Unscoped host/user authority behavior remains unchanged.

Exit evidence: same-run worker execution succeeds; cross-run reads/execution and
new-run start fail with `KAF_AUTHORIZATION_BINDING_MISMATCH`; unscoped controls
pass.

**Completed locally at 2026-09-04T07:14:30Z.** The shared runtime boundary now
checks exact run identity, loads the stored work-order identity before any
early-return or command-replay path, rejects scoped authority for run creation,
and limits scoped `system_worker` authority to execute/read/event operations.
Focused replay, cross-run, wrong-work-order, denied worker-cancellation, and
legitimate same-run controls pass. The owning runtime and PostgreSQL worker
package tests and typechecks also pass. This is unreleased local evidence.

### Phase 2 — production typed-input boundary

Require the production facade to validate a work-order input against the exact
registered agent schema before admission or persistence.

Design checkpoint: preserve request/command digest identity. Validation must not
silently replace the request with a transformed/defaulted value after the
caller computed its command digest. If transformed input is supported, the API
must define which representation is authoritative.

Exit evidence: malformed input is rejected before `RunAccepted`; valid input and
local behavior remain compatible; schema-digest drift fails closed.

**Completed locally at 2026-09-04T07:25:03Z.** Production and local facade
starts now share an exact compiled-agent input validation boundary. It compares
the retained executable schema identity to the advertised `inputSchemaDigest`,
maps invalid input to stable `KAF_SCHEMA_INVALID`, and discards the parser's
returned representation so the original WorkOrder and command digest remain
authoritative. The production regression proves malformed input is rejected
before the kernel transaction is entered and valid input reaches it. An
independent read-only review found no scoped bypass or legitimate-input
regression. This is unreleased local evidence.

### Phase 3 — native effect replay contract

Resolve the ambiguity around an existing `native + dispatched` effect.

- If `native` means provider-enforced idempotency, encode that guarantee in the
  registration contract and prove same-key replay behavior.
- Otherwise, park the effect as uncertain unless a separate replay-safety proof
  is registered.
- Preserve reconcilable lookup behavior, `none` parking, transactional atomicity,
  and acknowledged-result recovery.
- Every actual dispatch attempt must be visible in run truth.

Exit evidence: a crash at the committed dispatch boundary cannot cause an
unproved duplicate external effect; legitimate replay/recovery is deterministic.

**Completed locally at 2026-09-04T07:42:22Z.** A `native` label is no longer
treated as sufficient provider replay proof: existing `native + dispatched`
and `none + dispatched` records transition to uncertainty and suspend instead
of dispatching again. Reconcilable retries require a runtime-validated
`not_applied` result, exact durable strategy/registration/operation-key
binding, a checkpointed `EffectDispatched` attempt, and an attempt-qualified
active-execution reservation. Crash/restart coverage includes a pre-existing
attempt-one reservation and proves the safe attempt-two dispatch. An
independent read-only review found no remaining scoped bypass or regression.
This is unreleased local evidence.

### Phase 4 — terminal failure taxonomy

Classify errors after a run is accepted:

- deterministic run-owned failures append `RunFailed` with a stable registered
  code;
- cancellation appends `RunCancelled`;
- uncertain effects suspend/park;
- lease loss, storage concurrency, simulated crash boundaries, and integrity
  uncertainty remain recoverable or operator-visible and are not falsely
  terminalized;
- failures before admission remain request failures.

Apply the same taxonomy to agent and compensation execution. Decide explicitly
whether the caller receives a terminal result or a rejection after the terminal
event, then make facade `wait()` behavior consistent.

Exit evidence: representative KAF, schema, adapter, concurrency, crash, and
uncertain-effect cases each reach their intended state.

**Completed locally at 2026-09-04T08:09:38Z.** Accepted runs now distinguish
deterministic terminal failures, explicit cancellation, uncertain external
outcomes, and recoverable host/integrity failures. Model emissions, policy
decisions, retry classifications, verifier results, and evidence records are
runtime-validated before they can influence run truth. Stable `RunFailed`
events contain only registered KAF codes and safe details; unknown model/tool
outcomes suspend without persisting raw errors. Compensation cancellation uses
the same terminal event contract, and the local facade retains a rejected
background execution until `wait()` observes it. An independent read-only
review found malformed policy/classifier/verifier/evidence bypasses; those were
closed and covered before the phase was accepted. This is unreleased local
evidence.

### Phase 5 — PostgreSQL retention and role isolation

Separate tenant retention from operator-wide maintenance.

- Add a tenant-scoped purge API that uses an explicit tenant predicate and
  tenant transaction.
- Keep any global purge behind an explicitly named operator-only boundary;
  deprecate ambiguous global methods rather than silently changing their role.
- Test RLS with a real non-owner runtime role: unset tenant sees/deletes nothing,
  a set tenant cannot cross tenants, and only the maintenance role may perform
  global retention.
- Decide `FORCE ROW LEVEL SECURITY` from that role model; do not enable it
  blindly if it destroys the documented maintenance boundary.
- Add real PostgreSQL coverage to CI once the role test is deterministic.

Exit evidence: tenant deletion cannot cross tenants and the maintenance path is
explicitly privileged and tested.

**Completed locally at 2026-09-04T08:30:15Z.** Protected-record stores now
expose tenant-scoped purge methods with explicit tenant SQL predicates and
transaction-local RLS context. Ambiguous global methods fail closed; global
expiry requires the explicitly marked operator maintenance boundary. RLS
remains enabled but not forced so a table-owner maintenance role can cross
tenants, while a real `NOBYPASSRLS` non-owner test proves unset and cross-tenant
denial. An independent review found that the original WorkOrder foreign keys
made both new purge paths fail on accepted runs. Migration `012` now preserves
immutable run/wakeup identity bindings independently of the protected
WorkOrder, while an insert trigger validates the parent and both digests under
`FOR KEY SHARE`. The real PostgreSQL regression proves tenant and global purge,
retained run/wakeup evidence, and orphan-binding rejection. This is unreleased
local evidence.

### Phase 6 — shared parser, serialization, and adapter boundaries

Implement independently verified fixes in this order:

1. canonical JSON writer/reader symmetry for unsafe integral numbers;
2. tenant-qualified in-process cancellation keys and review of tenant-bound UoW
   port methods;
3. HTTP schema failures mapped through `parseWire()` to a stable 400 response;
4. MCP tools without an `outputSchema` accepting valid text-only MCP content;
5. AI SDK no-tool streams surfacing provider error/abort parts;
6. dead `egressBroker`, model `targetDigest`, authorization-reservation state,
   and tool-credential fields either wired to a consuming boundary or removed
   through a compatibility-aware deprecation.

Each item gets its own regression and owning-package check.

**Completed locally at 2026-09-04T09:28:54Z.** Strict JSON parsing now rejects
numeric wire aliases that would round to a different canonical decimal value,
and the writer's exponent forms round-trip. In-process tenant/run/resource
identities use canonical tuples across runtime, policy, admission, credential,
agent, evidence, and worker boundaries. HTTP mutation bodies are parsed through
their public schemas before both digesting and invocation. MCP distinguishes an
absent output schema from a declared one while accepting valid text-only
content only in the former case. AI SDK provider errors and aborts now surface
for both tool and no-tool streams. Previously decorative authorization and
credential fields are either consumed, fail closed, or explicitly deprecated
without breaking the legacy public shape. Legacy durable `reserved`
authorizations remain readable, while new prepared effects atomically persist
the consumed lifecycle. An independent current-tree review reran 488 focused
tests and the ten scoped package typechecks and found no remaining reportable
security or correctness blocker. The complete 47-task workspace typecheck also
passed. This is unreleased local evidence.

### Phase 7 — local approval as an explicit product feature

This is not a present authorization bypass: the local facade currently denies
approval-requiring work. Implement it only as a complete feature:

- atomic one-use approval claims in the memory UoW;
- process-local challenge issuer and deterministic preview wiring;
- `require_approval` preserved through policy evaluation;
- issue/approve/reject/resume flows proven through published facades;
- truthful `humanDecisions` capabilities and a reachable fixture UI.

Changing only `require_approval` from deny to pass-through is forbidden.

**Completed locally at 2026-09-04T10:36:20Z.** The local facade now preserves
the approval decision, issues process-local one-use challenges, binds the
recorded approval to the exact decision, tool, arguments, target, preview, and
principal, then resumes the pending call without double counting. The
human-readable display is part of the preview digest and the Next.js fixture
renders the exact requested item; preview producers are explicitly responsible
for excluding secrets. Memory transactions roll claims back on failure. The
approval-purchase example covers approve, reject, replay, and resume, while the
static bearer fixture remains single-factor and cannot satisfy R4. Independent
review found and closed the initial opaque-digest UI and ignored-item fixture
gaps. R3 compensation and production R5 presence remain host boundaries.

### Phase 8 — release and quality gates

1. repair placeholder matching and add self-tests for every marker;
2. redesign advisory evidence so normal CI is reproducible without accepting a
   permanently stale snapshot, while lockfile changes still require fresh
   network-authorized evidence;
3. exercise durable PostgreSQL, TLS, container, UI, and platform gates in the
   appropriate CI/release workflows instead of relying only on a workstation;
4. expand dead-code analysis to package sources and either configure or remove
   unused size tooling;
5. derive CLI/adapter/protocol versions from package metadata;
6. reconcile changesets, changelog entries, supported-version tables, and
   release workflow inputs.

Exit evidence: a clean checkout can run the documented aggregate without a
time-decayed false failure, and a changed lockfile cannot pass on old advisory
evidence.

**Implementation completed locally; final aggregate gate blocked.** The
placeholder scanner now has executable self-tests, Knip scans package sources,
unused size tooling is removed, package/protocol versions derive from manifests,
and Changesets plus protected workflows derive one coordinated 19-package
version. CI now names durable PostgreSQL, TLS, container, UI, and platform
contracts. Advisory snapshots no longer fail merely because time passed, but
remain checksum- and lockfile-bound. The current lockfile digest differs from
the last authorized snapshot, so offline verification correctly fails closed.
Refreshing it calls npm's advisory endpoint and sends dependency-graph/
lockfile-derived metadata; that external disclosure requires explicit user
authorization and was not bypassed.

### Phase 9 — user surface and documentation

- Make initializer/README expected events match the generated agent; prefer a
  real governed read tool over a fictitious `ToolCallCompleted` claim.
- Add an opt-in real-provider smoke/example without making live keys part of
  required CI.
- Replace hard-coded portable-agent events with an actual runtime path and
  honest platform entry points.
- Keep production-safe Next.js defaults and correct any documentation that
  claims preview is the default.
- Restore enough public security documentation for an Apache-2.0 contributor to
  understand the model without private-repository access.
- Repair English/Turkish semantic and safety parity.
- Use portable command spellings in future evidence records; do not rewrite
  historical commands merely to hide their execution environment.

**Completed locally at 2026-09-04T10:36:20Z.** Generated projects now register
and execute a real governed R1 read tool and their documented event trail is
integration-tested. The portable example uses a real local runtime and exposes
honest Node, Vercel, and Cloudflare-compatible entry signatures. The quickstart
has an opt-in AI SDK v7 provider smoke path that is excluded from required CI
and refuses to run without an explicit enable flag. The Next.js README describes
its production-shaped fail-closed default and explicit preview profile. A local
security-document index restores public trust-boundary context, while English
and Turkish home pages now carry matching event and safety claims.

### Phase 10 — decisions and non-defects

The following are not automatic code fixes:

- founder-led governance and assistant-authored commits;
- the `KAF_` naming history;
- host-injected cryptographic signers/verifiers;
- fail-closed egress defaults;
- private executor conformance as a release prerequisite;
- thin platform packages and the 20-package topology;
- splitting the large runtime state machine.

Package consolidation and runtime decomposition require an ADR, public API and
semver analysis, packed-consumer migration evidence, and a maintainer decision.
The ICLA date conflict requires counsel-approved replacement text, a new
immutable document, a new signature generation, and remote workflow authority;
it is `blocked`, not safe for an automated in-place edit.

**Disposition completed locally at 2026-09-04T10:36:20Z.** Host-provided
signers are an intentional trust boundary and the evidence package already
limits its authenticity claims. Default-deny egress is the correct behavior.
Thin adapters, package count, runtime size, founder-led governance, contributor
count, and assistant-authored commits are maintainability or governance facts,
not demonstrated authorization bypasses. PostgreSQL deletion support now
documents that it covers lifecycle-managed protected records, not append-only
run truth or immutable evidence. The threat model no longer overstates a shared
PostgreSQL contract-suite invocation: PostgreSQL behavior is instead covered by
its unit and real-role integration suites. Worker delegation was a genuine
claim defect and is now conservatively single-factor rather than manufacturing
phishing-resistant human authentication from scheduler metadata. Runtime
decomposition and package consolidation remain ADR/semver work; the ICLA issue
remains counsel-blocked.

## 4. Roast finding disposition map

| Finding group                                                  | Initial disposition                                       | Phase |
| -------------------------------------------------------------- | --------------------------------------------------------- | ----- |
| Production input validation                                    | confirmed fix                                             | 2     |
| Nonterminal execution failures                                 | confirmed, taxonomy required                              | 4     |
| Unenforced `runScope`                                          | confirmed fix                                             | 1     |
| Local approval unreachable                                     | feature gap, complete implementation only                 | 7     |
| Native effect redispatch                                       | confirmed behavior, contract decision                     | 3     |
| Tenantless purge / RLS proof                                   | confirmed API/proof gap                                   | 5     |
| Tenantless ports / abort key                                   | mixed; fix concrete cross-tenant paths                    | 6     |
| Decorative egress/target/reservation/credential fields         | verify then wire/deprecate                                | 6     |
| Canonical JSON asymmetry                                       | confirmed fix                                             | 6     |
| Stable-code registry gaps                                      | fixed; `RunFailed` accepts registry members only          | 4/10  |
| Runtime/capability structure                                   | ADR candidate, not immediate defect                       | 10    |
| Attestation delegates crypto to host                           | no change unless claims exceed contract                   | 10    |
| Process-local credentials/kill switches                        | document host duty; add durable example if needed         | 9     |
| Worker claims phishing-resistant authentication                | fixed; conservative single-factor delegation              | 10    |
| Deletion support / migration downgrade                         | documented at record-class granularity                    | 9/10  |
| Shared store contract suite only covers memory                 | claim corrected; PostgreSQL has separate real DB coverage | 5/10  |
| Egress callback defaults to deny                               | intended fail-closed behavior                             | 10    |
| HTTP malformed input becomes 500                               | confirmed fix                                             | 6     |
| MCP text-only output rejected                                  | confirmed fix                                             | 6     |
| AI SDK provider errors hidden                                  | confirmed fix                                             | 6     |
| Initializer/README event mismatch                              | confirmed fix                                             | 9     |
| No concrete provider dogfood                                   | product-evidence gap                                      | 9     |
| Next fixture/UI mismatch                                       | docs plus Phase 7 feature work                            | 7/9   |
| Portable example fakes events                                  | confirmed example gap                                     | 9     |
| CLI/version/rendering issues                                   | verify and fix separately                                 | 8     |
| Advisory TTL and placeholder gate                              | confirmed fixes                                           | 8     |
| CI/Knip/security-case claims                                   | evidence and scope corrections                            | 8     |
| Changelog/changeset drift                                      | confirmed release-record fix                              | 8     |
| Turkish parity                                                 | confirmed editorial fix                                   | 9     |
| Machine paths, governance, package size, authorship statistics | optics or historical facts                                | 9/10  |
| CLA date conflict                                              | counsel/immutable-document blocker                        | 10    |
| Private security documentation                                 | public-doc gap                                            | 9     |

## 5. Progress

| Phase | Status    | Evidence location                  |
| ----- | --------- | ---------------------------------- |
| 1     | completed | `docs/releases/v0.2-readiness.md`  |
| 2     | completed | `docs/releases/v0.2-readiness.md`  |
| 3     | completed | `docs/releases/v0.2-readiness.md`  |
| 4     | completed | `docs/releases/v0.2-readiness.md`  |
| 5     | completed | `docs/releases/v0.2-readiness.md`  |
| 6     | completed | `docs/releases/v0.2-readiness.md`  |
| 7     | completed | `docs/releases/v0.2-readiness.md`  |
| 8     | blocked   | npm advisory refresh authorization |
| 9     | completed | `docs/releases/v0.2-readiness.md`  |
| 10    | completed | dispositions above; ICLA external  |

## 6. Verification ladder

For every phase:

1. inspect the candidate diff;
2. run the focused reproducer and alternate unsafe input;
3. run the legitimate control and nearest tests;
4. run package typecheck/build/test;
5. run the relevant cross-package or integration gate.

Before closing the overall remediation:

```sh
pnpm verify
```

Network-authorized advisory refresh, external links, provider smoke tests,
publication, deployment, and remote settings remain separate gates.

## 7. History

- 2026-09-04: all non-network implementation and local gates completed. The
  canonical aggregate exposed and closed stale API-report and working-tree
  deletion-enumeration defects, then stopped fail-closed because the current
  lockfile digest does not match the last network-authorized npm advisory
  snapshot. No refresh or alternate network path was used.
- 2026-09-04: source tree matched the reviewed tree; plan created after direct
  source inspection and an independent read-only security-boundary pass. No
  finding is marked fixed by this entry.
