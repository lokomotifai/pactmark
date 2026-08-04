# ADR-0001: Evidence-native bounded work

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Pactmark maintainers

## Context

General-purpose chat abstractions do not state who authorized work, which
effects were permitted, whether execution survived interruption, what artifact
was produced, or what a successful run actually proves. Treating fluent model
output as authority or evidence is unsafe and makes operational claims hard to
audit.

Pactmark needs a narrow product center that remains meaningful across model
providers and deployment platforms.

## Decision

Pactmark is a TypeScript framework for evidence-native, bounded work. Its
canonical lifecycle is:

```text
WorkOrder -> governed Run -> controlled Effect -> Artifact -> Verification -> EvidenceRecord
```

The framework owns typed work intent, purpose, budgets, data class, risk,
decision rights, capability grants, policy decisions, run events, effects,
artifacts, verification, and claim-bounded evidence. A model proposes content
or actions; it never becomes an authority.

Pactmark is a library and portable HTTP/runtime surface, not a hosted control
plane. v0.1 centers a small provider-neutral kernel and production-shaped
adapters. It does not include a visual builder, generic multi-agent
orchestration, remote skill marketplace, universal memory/RAG layer, browser
automation, communications platform, or production arbitrary-code sandbox.

Adoption depth, agent autonomy, work transformation, evidence quality, and
business outcome remain separate axes. The project will not derive a single
productivity or maturity score from them.

## Consequences

- Public APIs begin from a validated WorkOrder rather than a chat message.
- Bounded authority and evidence limitations are first-class outputs.
- Product scope can remain smaller than provider SDK or agent-platform feature
  lists.
- Hosts retain responsibilities that an open-source library cannot satisfy,
  including identity, tenant isolation, secret custody, network enforcement,
  retention, deployment, and incident response.
- Documentation must distinguish tested behavior, declared boundaries, and
  unverified external configuration.

## Rejected alternatives

- **Chat-first SDK:** does not encode work authority or evidence semantics.
- **Provider-specific agent harness:** couples core meaning to one vendor.
- **Broad automation platform in v0.1:** dilutes the security and durability
  contract before the kernel is demonstrated.
