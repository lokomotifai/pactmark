# Pactmark repository guidance

This file is the durable engineering contract for Codex and contributors. Release evidence and remaining gates are recorded in [docs/releases/v0.1-readiness.md](./docs/releases/v0.1-readiness.md).

## Product and language

- Product name: Pactmark.
- Canonical code, API identifiers, errors, and public documentation are English.
- Required Turkish documentation preserves semantic and safety parity while keeping API names in English.
- Never market Pactmark as exactly-once, fully secure, certified, or production-isolated beyond tested capabilities.

## Repository layout and dependency direction

- `packages/core`, `packages/runtime`, `packages/policy`, and `packages/evidence` are the portable kernel.
- Vendor, model, storage, protocol, and host behavior belongs in adapters.
- Workspace manifests and executable dependency-boundary checks define the production package graph. Cycles and undeclared deep imports are forbidden.
- Tests may consume `@pactmark/testing` only as an explicit development dependency. Test helpers must never leak into production exports.
- `briefs/` and `research/`, when locally present, are private bootstrap inputs. Never track, package, document-build, containerize, or publish them.

## Security invariants

- The model is never authority. Policy, grants, approvals, budgets, schema validation, credentials, and effect execution stay outside model context.
- External input is `unknown` until runtime validation succeeds.
- Default policy is deny. Unknown metadata, scope, risk, capability, or runtime support fails closed.
- Resolved tool and model credentials never enter events, context snapshots, telemetry, artifacts, evidence, errors, or ordinary diagnostics.
- Every tenant identifier participates in every storage access path.
- Persist append-only events as run truth. Projections are rebuildable caches.
- Never repeat an uncertain external effect without the registered effect strategy proving that retry is safe.
- Do not persist hidden chain-of-thought.
- Production claims require executable evidence; file existence and green no-op scripts are not evidence.

## Toolchain and commands

Use the pinned pnpm workspace and Node.js 24 for development. Node.js 22 and 24 are the supported release lines.

Run the smallest relevant check after an edit. Before closing a release gate, record the command and observable behavior in the release-readiness record. Before release readiness, run:

```sh
pnpm verify
```

The canonical aggregate may not hide live provider calls, secrets, or external deployment. Network-authorized advisory, link, platform, and publication gates remain explicitly separate.

## Code conventions

- Modern ESM only; publish explicit `exports`, declarations, and source maps.
- TypeScript strictness follows `tsconfig.base.json`, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Public and persisted contracts use versioned runtime schemas. Zod is the v0.1 public schema boundary.
- Avoid `any`. If unavoidable at a third-party boundary, justify it inline and isolate it.
- Inject clocks, IDs, persistence, credentials, models, tools, network, telemetry, and scheduling.
- Portable packages must not import Node built-ins, environment variables, platform SDKs, or provider SDKs.
- Stable public failures use KAF error codes; consumers never parse English messages.

## Tests and Definition of Done

- Required behavior must work without a live model key or SaaS account.
- Add deterministic success, denial, malformed-input, concurrency, cancellation, and crash-boundary coverage in proportion to the change.
- No skipped/focused tests, unexplained placeholders, empty packages, fake success scripts, or production test doubles.
- Package behavior is accepted from packed tarballs in independent consumer fixtures, not from workspace links alone.
- Preserve user changes and unrelated dirty-worktree content.
- Do not create a remote, push, publish, reserve a name, deploy, or change external settings without explicit user authorization.

## Progress records

Update the applicable release-readiness record as work advances. Completion entries include a UTC timestamp, exact command, and observable proof. Do not mark a release gate complete until its exit criteria pass.
