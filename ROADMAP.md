# Pactmark roadmap

Pactmark's roadmap is a statement of direction, not a delivery promise. It is
kept outcome-oriented so contributors can shape the implementation through
issues and proposals.

## Now — make the v0.1 contract easy to adopt

- Turn first-run examples into dependable contributor and evaluator paths.
- Collect real integration feedback on `WorkOrder`, policy, effect, artifact,
  verification, and evidence contracts without weakening their boundaries.
- Improve API navigation, error-code guidance, English/Turkish parity, and
  accessibility testing.
- Grow a review culture around well-scoped `good first issue` and `help wanted`
  work rather than optimizing for raw contribution counts.

## Next — harden durable host profiles

- Expand PostgreSQL worker, cancellation, lease, replay, reconciliation, and
  crash-boundary coverage.
- Make Vercel, Node/OCI, MCP, OpenTelemetry, and the experimental Cloudflare
  adapter easier to evaluate from independent consumer fixtures.
- Document upgrade and compatibility policy with evidence from more than one
  released patch line.
- Add maintainers only when contributors have demonstrated sustained review and
  stewardship in a clear scope.

## Later — ecosystem contracts

- Evaluate additional model, protocol, storage, and effect adapters without
  moving vendor behavior into the portable kernel.
- Develop interoperable evidence export and verification patterns where a real
  multi-implementation use case exists.
- Revisit governance structure when active contributors, not aspiration, justify
  scoped teams or delegated ownership.

## Intentionally not promised

Pactmark does not have a roadmap commitment to become a generic chat SDK,
no-code builder, swarm scheduler, hosted control plane, or production
arbitrary-code sandbox. No roadmap item implies exactly-once external effects,
universal provider support, production isolation, certification, or a release
date.

Use a [feature proposal](https://github.com/pactmark/pactmark/issues/new?template=feature.yml)
to challenge or extend this direction. A useful proposal starts with a user
problem, states non-goals, and explains authority, portability, compatibility,
privacy, and evidence impact.
