# Pactmark product principles

This document is a public, normative implementation prerequisite. Together
with ADR-0001 through ADR-0007, it defines the product and engineering intent
that Pactmark changes must preserve. “Must,” “must not,” “should,” and “may” are
used in their ordinary normative sense.

## Evidence-native work

Pactmark exists to help software agents perform bounded work under explicit
authority and produce inspectable results. Its unit of intent is a validated
WorkOrder, not an unbounded conversation. A WorkOrder states the goal, purpose,
inputs, role/workflow/risk context, decision owner, budget, data class, and
requested capabilities.

The product lifecycle is:

```text
WorkOrder -> governed Run -> controlled Effect -> Artifact -> Verification -> EvidenceRecord
```

Each link must retain identity and provenance. A later stage must not broaden
the claim or permission of an earlier stage by convenience. Completion means
the runtime reached a terminal state; it does not automatically mean the
artifact is correct, the outcome is valuable, or the workflow is reusable.

## Human decision rights

Humans and host systems retain decision authority. Models may propose,
summarize, classify, or request a tool action, but must never authenticate a
subject, issue a grant, approve their own effect, expand a budget, select a
secret, or declare a policy exception.

A WorkOrder identifies its decision owner. When a decision is required, the
runtime must pause with a persisted, exact, understandable request. Approvals
must bind an authenticated actor and a one-time challenge to one canonical
proposed-effect digest. Changed content, target, scope, price, permission, or
other material input requires a new decision. Rejection and expiry are durable
outcomes, not prompt suggestions.

Delegated workers are system actors. They may exercise only a narrowed,
persisted run delegation and do not inherit the initiating human's decision
rights.

## Purpose and permission are separate

Purpose explains why data or authority is used. Permission states what an
authenticated principal may do. Neither implies the other.

Every protected operation must satisfy both:

- a purpose and data classification compatible with the WorkOrder; and
- explicit, current, narrow authority for the principal, tenant, tool/action,
  normalized resource, count, and time window.

A useful goal does not authorize a tool. A valid grant does not permit using
data for an unrelated purpose. Skills, prompts, tool metadata, model output,
and retrieved content cannot create or widen authority. Unknown metadata,
ambiguous scope, failed validation, or unavailable enforcement must fail
closed.

## Independent axes

Pactmark must not collapse the following into one “maturity,” “automation,” or
“productivity” score:

- **Adoption depth:** how regularly and broadly a workflow is used.
- **Agent autonomy:** which steps proceed without a new human decision.
- **Work transformation:** whether the workflow assists, changes, or replaces
  prior task structure.
- **Evidence quality:** how strong, repeatable, current, and independent the
  support for a bounded claim is.
- **Outcome:** the result relevant to the user or organization.

These dimensions may be reported side by side when the measurements, cohort,
permissions, and limitations are explicit. Movement on one axis must not be
presented as proof of movement on another.

## Reuse requires repeated proof

One successful run can support a claim about that run. It cannot establish a
proven reusable pattern.

Pattern maturity is assessed at an explicit
`roleFamily x workflowId x riskClass` scale unit. Promotion must require
versioned criteria and repeated, independent observations across the declared
scope. Relevant failures, reversals, human interventions, stale evidence, and
negative verification results remain part of the record. Changing material
agent, policy, tool, verifier, model-security, resource, or execution identity
may invalidate or narrow prior evidence.

Pattern manifests must state what is supported and what is not. They must not
turn a technical verification into a business, compliance, safety, or workforce
claim without evidence designed for that claim.

## Privacy and no surveillance

Pactmark must not become a behavioral-surveillance or hidden worker-ranking
system. The project excludes automated talent scores, concealed productivity
scores, and member ranking.

Default installation sends no remote Pactmark telemetry. When a host explicitly
configures OpenTelemetry, the default is metadata-only. Prompts, completions,
file bodies, tool arguments/results, credentials, highly restricted fields,
and chain of thought are absent from telemetry, logs, audit, and evidence by
default. Chain of thought is never persisted.

Operational model context required for durable resume may be stored only in a
separate protected ContextStore with explicit tenant, purpose, retention,
deletion, and encryption controls. It is not an analytics source, audit record,
or evidence shortcut. Run events, workspace content, domain knowledge, secrets,
telemetry, artifacts, and evidence remain separate data classes and storage
concerns.

Collect the minimum information needed for the stated purpose. Make visibility,
retention, deletion, and access boundaries explicit. Evidence export cannot
increase access to the underlying artifact or reveal another tenant's data.

## Honest control and platform claims

Pactmark describes controls by what is actually enforced:

- Default-deny policy, grants, approvals, budgets, schema validation, and effect
  execution are model-independent.
- At-least-once execution is controlled with concurrency checks, idempotency,
  effect records, and reconciliation; global exactly-once is not claimed.
- The trusted in-process executor is not a production arbitrary-code sandbox.
- Declared egress restrictions are not network isolation unless the host
  enforces them.
- Streaming and function duration are not durable scheduling.
- Local build compatibility is not proof of a live deployment profile.
- An open-source library is not by itself “enterprise-ready,” certified, or
  compliant.

Documentation and evidence must distinguish verified local behavior, attested
platform behavior, and pending external configuration.

## Portable, replaceable infrastructure

Core semantics must remain independent of model provider, database vendor,
telemetry backend, and deployment host. Vendor and platform SDKs belong in
optional adapters and must not leak into core types. Standard Web primitives
define the portable HTTP boundary. Concrete services may add capabilities but
cannot bypass policy or redefine run truth.

Commodity infrastructure should be delegated to mature open-source libraries
where appropriate. Pactmark owns the work, authority, run, effect, artifact,
verification, and evidence semantics that make those components coherent.

## Public accountability

Security, compatibility, durability, and evidence claims need executable tests
or an explicit limitation. Public ADRs record material decisions. Releases must
be reproducible from reviewed source, identify exact artifacts and dependencies,
and preserve required license and attribution information.

Private research or operational inputs are never a prerequisite for a public
checkout and must not appear in packages, documentation builds, containers,
SBOM descriptions, or releases. Public implementation work relies on this
document and the accepted ADRs.
