# ADR-0005: Default-deny, model-independent security

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Pactmark maintainers

## Context

Models and tools consume attacker-influenced text and can produce convincing
but untrusted requests. Prompt instructions are not an enforcement boundary.
Agent systems also risk confused-deputy actions, credential crossover, tenant
mixing, excessive egress, approval replay, and sensitive-data leakage through
logs or evidence.

## Decision

The model is never an authority. Deterministic code outside model context owns
authentication, tenant binding, policy, capability grants, approvals, budgets,
schema validation, credential resolution, egress, effect dispatch, and evidence
claims.

Policy denies by default. Unknown or ambiguous tool metadata, risk, scope,
schema identity, resource normalization, runtime capability, or policy result
fails closed. Capability grants are narrow, expiring, count-bounded, purpose-
bound, principal- and tenant-bound, WorkOrder-bound, and action/resource-bound.
Skills and model/tool output cannot mint or widen them.

State-changing work requires an exact proposed-effect digest and, where policy
requires it, an authenticated one-time decision challenge and immutable,
expiring, single-use approval. Replay cannot consume authority twice or apply
approval to a changed effect. Uncertain remote outcomes move to reconciliation,
not automatic acknowledgement.

Tool and model credentials use separate typed references and resolvers. Secret
values do not enter agent definitions, model context, events, logs, telemetry,
artifacts, or evidence. Egress is denied by default and uses allowlisted,
normalized destinations through an injected broker. A trusted in-process
executor advertises declared controls honestly and is not called a sandbox.

Remote telemetry is off by default. Configured OpenTelemetry is metadata-only
by default. Prompts, completions, file bodies, tool arguments/results, chain of
thought, and highly restricted fields are excluded from telemetry, logs,
audit, and evidence unless a separately documented, purpose-bound policy
explicitly permits a safe representation. Chain of thought is never persisted.

## Consequences

- Security invariants require model-less adversarial and zero-call tests.
- Hosts must authenticate subjects and issue authority outside the runtime.
- Missing host enforcement reduces readiness and must not be hidden by adapter
  terminology.
- Useful diagnostics rely on typed decisions, reason codes, sanitized results,
  summaries, and digests instead of raw sensitive payloads.
- Some requests pause or fail even when a model could technically execute them.

## Rejected alternatives

- **System-prompt policy:** attacker-controlled context can influence it.
- **Allow unless denied:** unknown integrations silently acquire authority.
- **One general credential resolver:** enables cross-slot credential confusion.
- **Raw payload observability by default:** creates an unnecessary surveillance
  and breach surface.
