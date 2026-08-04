# Pactmark

Pactmark is an evidence-native TypeScript framework for agents that perform bounded work under explicit authority. A Pactmark run begins with a validated WorkOrder, records governed tool effects as an append-only event history, produces content-addressed artifacts, and completes only through declared verification.

The repository is under active development toward version 0.1.0. No npm package or public deployment is claimed yet. The public installation command will be documented as verified only after the release gates in [PLAN.md](./PLAN.md) pass and an authorized publication is inspected.

## Product boundary

Pactmark is not a generic chat SDK, a no-code builder, a swarm orchestrator, or a production arbitrary-code sandbox. Its kernel owns work contracts, authority, durable run semantics, governed effects, artifacts, verification, and bounded evidence. Provider, protocol, storage, and platform integrations live behind adapters.

The core safety rule is simple: the model may propose an action, but it is never the authority that permits that action.

## Local repository setup

Development targets Node.js 24 and supports Node.js 22 and 24. The monorepo uses pnpm.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

During the initial bootstrap, install and verification commands become available as their owning work packages are materialized. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the current contributor path and [PLAN.md](./PLAN.md) for executable milestones and release gates.

## Architecture

The intended public flow is:

```text
WorkOrder
  -> bounded agent run
  -> governed tool effects
  -> artifact
  -> verification
  -> EvidenceRecord
```

Run truth is append-only. Projections are rebuildable. Durable production profiles use Postgres and do not depend on an HTTP request, function memory, or a local filesystem remaining alive. Side effects use explicit strategies, stable operation keys, authorization reservations, acknowledgements, and reconciliation instead of an exactly-once claim.

## Status and licensing

- Implementation status: private local bootstrap; public release not authorized.
- License: Apache-2.0.
- Canonical public language: English, with required Turkish companion documentation.
- Telemetry: no phone-home telemetry; configured observability is metadata-only by default.

Security issues must follow [SECURITY.md](./SECURITY.md). General support boundaries are in [SUPPORT.md](./SUPPORT.md).
