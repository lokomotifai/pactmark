# ADR-0003: Event-derived runtime and controlled at-least-once execution

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Pactmark maintainers

## Context

Agent work may be interrupted between model calls, tool preparation, external
dispatch, acknowledgement, persistence, and response delivery. A mutable run
row cannot reliably explain what happened, and no application-level library
can promise exactly-once delivery across arbitrary external systems.

## Decision

Append-only, versioned `RunEvent` records are the source of run truth. Events
have a monotonic per-run sequence and are appended with optimistic concurrency.
Run state and query projections are deterministic, rebuildable reductions of
the event history, never an independent authority.

Execution uses at-least-once processing. Mutating commands carry canonical
request digests and durable idempotency records. State-changing tools use an
effect lifecycle that separates preparation, authorization reservation,
dispatch, acknowledgement, uncertain outcome, reconciliation, and
compensation. An idempotency key does not turn an unknown remote outcome into
success.

Checkpointing persists enough protected operational context to resume. Model
context is stored separately from audit events and evidence, under tenant,
purpose, retention, deletion, and encryption controls. Drivers schedule or wake
runs but do not own their state semantics.

Memory storage is for tests and local demonstration. Durable production
profiles use Postgres through portable store contracts and a separately
operated scheduler/worker where automatic background progress is claimed.
Request duration or response streaming alone is not durable execution.

## Consequences

- Reducers and transition rules must be deterministic and version-aware.
- Replay, duplicate delivery, stale-version conflict, crash recovery, uncertain
  effect, and projection rebuild tests are mandatory.
- External-effect documentation must say “controlled at-least-once,” never
  “globally exactly once.”
- Hosts must provision durable storage and an appropriate wake-up mechanism for
  automatic continuation.
- Operational context receives stronger confidentiality handling than ordinary
  event metadata.

## Rejected alternatives

- **Mutable run state as truth:** loses decision history and weakens replay.
- **Exactly-once claim:** cannot be guaranteed across uncoordinated remote
  services.
- **Platform function as scheduler:** invocation lifetime is not a durable
  wake-up contract.
