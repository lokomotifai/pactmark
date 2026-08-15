<p align="center">
  <a href="docs/index.md">
    <img src="assets/brand/pactmark-logo.svg" width="132" height="132" alt="Pactmark">
  </a>
</p>

<h1 align="center">Pactmark</h1>

<p align="center"><strong>Governed TypeScript agents that leave evidence—not just answers.</strong></p>

<p align="center">
  Turn a validated <code>WorkOrder</code> into bounded execution, governed tool effects,<br>
  content-addressed artifacts, declared verification, and an <code>EvidenceRecord</code>.
</p>

<p align="center">
  <a href="https://github.com/lokomotifai/pactmark/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lokomotifai/pactmark/ci.yml?branch=main&amp;style=flat-square&amp;label=CI"></a>
  <a href="https://github.com/lokomotifai/pactmark/actions/workflows/security.yml"><img alt="Security baseline" src="https://img.shields.io/github/actions/workflow/status/lokomotifai/pactmark/security.yml?branch=main&amp;style=flat-square&amp;label=security"></a>
  <a href="https://www.npmjs.com/package/@pactmark/agent"><img alt="npm version" src="https://img.shields.io/npm/v/%40pactmark%2Fagent?style=flat-square&amp;label=npm&amp;color=D11F26"></a>
  <a href="https://github.com/lokomotifai/pactmark/releases/tag/v0.1.2"><img alt="Release provenance" src="https://img.shields.io/badge/release-provenance-verified-D11F26?style=flat-square"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-3B3F46?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img alt="Node.js 22 and 24" src="https://img.shields.io/badge/Node.js-22%20%7C%2024-3C873A?style=flat-square"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square"></a>
  <a href="docs/index.md"><img alt="English documentation" src="https://img.shields.io/badge/docs-English-17191F?style=flat-square"></a>
  <a href="docs/tr/index.md"><img alt="Türkçe dokümantasyon" src="https://img.shields.io/badge/dokümantasyon-Türkçe-D11F26?style=flat-square"></a>
  <a href="https://github.com/lokomotifai/pactmark/graphs/contributors"><img alt="Contributors" src="https://img.shields.io/github/contributors/lokomotifai/pactmark?style=flat-square"></a>
  <a href="https://github.com/lokomotifai/pactmark/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/lokomotifai/pactmark?style=flat-square"></a>
</p>

<p align="center">
  <a href="docs/getting-started/first-agent.md"><strong>Build a first agent</strong></a>
  ·
  <a href="docs/index.md"><strong>Read the docs</strong></a>
  ·
  <a href="examples/approval-agent/"><strong>Trace an approval boundary</strong></a>
  ·
  <a href="README.tr.md"><strong>Türkçe</strong></a>
</p>

---

> **The model is never the authority.** It may propose a tool call; it cannot
> grant itself scope, approve its own risk, resolve a credential, expand a
> budget, or declare its output verified.

Pactmark is an evidence-native framework for agents that perform bounded work
under explicit authority. It is for systems where “the model returned something
plausible” is not an acceptable definition of success.

Version **0.1.2** is a public early release. All 19 npm packages were published
through token-free trusted publishing with package provenance, then fetched
anonymously and matched against the immutable release checksums. That is
supply-chain evidence for those package bytes—not a claim that every Pactmark
deployment is production-ready or secure.

## The difference in one picture

![Diagram showing model output crossing Pactmark's schema, policy, capability, approval, budget, and dispatch boundary before a host-controlled effect](assets/readme/authority-boundary.png)

<p align="center"><sub><a href="assets/readme/authority-boundary.svg">View the accessible SVG source</a></sub></p>

Most agent libraries make model invocation and tool wiring easy. Pactmark is
concerned with what happens around that invocation:

| Question                                     | Pactmark's answer                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| What is the agent allowed to do?             | A validated work contract, default-deny policy, capability grants, risk class, and budget.                  |
| Who may approve a consequential action?      | A host-issued, scoped decision bound to the exact run and effect—not model text.                            |
| Where do provider and tool credentials live? | Behind host-owned credential ports; resolved values never enter model context or ordinary evidence.         |
| What happens after a crash?                  | Rebuild from append-only run truth; reconcile an uncertain external effect through its registered strategy. |
| What did the run actually produce?           | Content-addressed artifacts linked to declared verifier results.                                            |
| What may another system trust?               | A bounded, self-attested `EvidenceRecord`; portable authenticity additionally requires a host signature.    |

## Start in 60 seconds

The initializer creates a deterministic local agent. It needs no model key and
does not change global npm configuration.

```sh
npm create pactmark@latest -- my-agent
cd my-agent
npm run dev
```

Expected progress includes:

```text
RunAccepted
ToolCallCompleted
VerificationRecorded(status=pass)
RunCompleted
```

The generated project deliberately uses the ephemeral local profile: in-memory
state, a deterministic model fixture, and trusted in-process execution. It is a
learning and test path, not a production template disguised as one.

For the complete typed example, read
[`examples/minimal-tool-agent/src/example.ts`](examples/minimal-tool-agent/src/example.ts).
Its essential shape is:

```ts
const lookup = defineTool({
  id: "catalog.lookup@1",
  input: toolInput,
  output: toolOutput,
  security: {
    riskClass: "R1",
    requiredScopes: ["catalog:read"],
    egress: { mode: "none" },
    maxCallsPerRun: 1,
  },
  operation: { kind: "read", execute: lookupFixture },
});

const agent = defineAgent({
  id: "catalog-agent",
  version: "0.1.0",
  input,
  instructions,
  model,
  tools: { lookup },
  policy: definePolicy({ default: "deny", rules }),
  output,
  verifiers: ["schema@1"],
});
```

The omitted setup is not optional magic: the runnable source also declares the
model's security/resource profiles, authority issuer, `WorkOrder`, purpose,
data class, requested capabilities, budgets, and command identity.

## The run is the product boundary

![Diagram of a Pactmark run moving from WorkOrder through admission, bounded work, artifact and verification to an EvidenceRecord](assets/readme/run-lifecycle.png)

<p align="center"><sub><a href="assets/readme/run-lifecycle.svg">View the accessible SVG source</a></sub></p>

Every run begins with a runtime-validated `WorkOrder`. The work order binds:

- agent identity and version;
- goal and typed input;
- principal, tenant, purpose, data class, and retention;
- work/autonomy mode and the human decision owner;
- requested capabilities; and
- turn, model-call, tool-call, token, byte, and active-time budgets.

Admission rejects unknown or unsupported metadata. During execution, model and
tool I/O remain untrusted. A proposed effect crosses schema validation, policy,
grant, risk, approval, budget, and runtime-capability checks before dispatch.
Terminal success requires the declared verification path; a natural-language
claim of completion has no authority.

### Durable semantics without an exactly-once slogan

Pactmark records append-only events as run truth and treats projections as
rebuildable caches. Durable profiles use leases, operation keys, authorization
reservations, acknowledgements, checkpoints, and registered reconciliation or
compensation strategies.

This lets tested strategies avoid repeating a previously acknowledged effect
across specific crash boundaries. It does **not** turn an arbitrary external API
into a globally exactly-once system. When an effect's outcome is uncertain and
the strategy cannot prove a retry safe, Pactmark fails closed instead of
silently dispatching again.

## Architecture

The portable kernel does not import Node built-ins, environment variables,
platform SDKs, provider SDKs, or storage implementations. Host and vendor
behavior enters through explicit adapters.

```text
application / host
        │
        ├── authority · credentials · scheduler · executor · network controls
        │
   @pactmark/agent        ergonomic composition
        │
   ┌────┴───────────────────────────────────────────────┐
   │ portable kernel                                   │
   │ core ── runtime ── policy ── evidence             │
   └────┬───────────────────────────────────────────────┘
        │ ports
   ┌────┴───────────────────────────────────────────────┐
   │ stores · protocols · model adapters · host bridges│
   └────────────────────────────────────────────────────┘
```

The dependency graph and package boundaries are documented in
[`docs/architecture/dependencies.md`](docs/architecture/dependencies.md). Deep
imports and dependency cycles are rejected by repository checks.

### Package map

| Layer                          | Packages                                                                                                                                                                                                     | Responsibility                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Facade and kernel              | [`@pactmark/agent`](packages/agent/), [`core`](packages/core/), [`runtime`](packages/runtime/), [`policy`](packages/policy/), [`evidence`](packages/evidence/)                                               | Public composition, versioned contracts, orchestration, authority rules, artifacts and evidence.   |
| Storage and execution          | [`store-memory`](packages/store-memory/), [`store-postgres`](packages/store-postgres/), [`driver-postgres-worker`](packages/driver-postgres-worker/), [`executor-in-process`](packages/executor-in-process/) | Ephemeral tests, durable tenant-scoped state, worker loops, and trusted in-process tool execution. |
| Interfaces                     | [`http`](packages/http/), [`node`](packages/node/), [`mcp`](packages/mcp/), [`cli`](packages/cli/)                                                                                                           | Web-standard HTTP/SSE, Node server lifecycle, guarded MCP clients, and terminal-safe commands.     |
| Platform and provider adapters | [`ai-sdk`](packages/ai-sdk/), [`vercel`](packages/vercel/), [`cloudflare`](packages/cloudflare/), [`otel`](packages/otel/)                                                                                   | Optional vendor/platform integration without moving those dependencies into the kernel.            |
| Contributor tooling            | [`testing`](packages/testing/), [`create-pactmark`](packages/create-pactmark/)                                                                                                                               | Deterministic fakes/contract suites and the offline-capable initializer.                           |

Install only the packages your host owns. `@pactmark/agent` does not re-export
optional providers, databases, platform adapters, or telemetry.

## What the framework protects—and what it cannot

Pactmark is designed around several non-negotiable boundaries:

- **Default deny.** Unknown policy, scope, risk, metadata, or runtime support is
  a denial, not an invitation to guess.
- **Tenant in every storage path.** A tenant identifier participates in every
  access path; it is not optional filtering at the edge.
- **Credentials stay opaque.** Models and normal diagnostics receive references,
  never resolved tool or model credentials.
- **Human decisions are bound.** Approval is scoped to the exact challenge,
  effect, tenant, grant, and expiry.
- **Evidence is narrower than execution.** Hidden chain-of-thought is neither
  stored nor presented as proof; evidence carries declared, testable claims.
- **The host remains responsible.** Network isolation, identity, secret storage,
  retention, backup, provider terms, and incident response belong to the
  deployment that enforces them.

Pactmark is **not** a generic chat SDK, no-code builder, swarm orchestrator,
hosted control plane, or production arbitrary-code sandbox. Its trusted
in-process executor is explicitly not an isolation boundary. Read the
[security model](docs/security/security-model.md)
before evaluating a production-shaped host.

## Runtime and platform status

The labels below distinguish implementation evidence from a production claim.

| Surface                     | Current evidence                                                                                  | Boundary                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Local memory runtime        | Deterministic unit, integration, consumer, replay, cancellation, and concurrency tests            | Ephemeral development/test profile; readiness reports false for production.          |
| PostgreSQL store and worker | Real PostgreSQL migration, tenant, lease, checkpoint/resume, TLS, and crash-boundary gates        | Host still owns database operations, scheduling, credentials, backup, and isolation. |
| Node and OCI                | HTTP/SSE contracts and a read-only, network-bounded local container conformance fixture           | No registry, multi-architecture, or production availability claim.                   |
| Next.js / Vercel            | Adapter, route, auth-denial, UI security/accessibility, and historical protected Preview evidence | No current Vercel Production deployment or production support claim.                 |
| Cloudflare Workers          | Experimental Web-standard adapter, dry-run tests, and an ephemeral staging deployment             | Readiness intentionally fails for durable production requirements.                   |
| MCP                         | Deterministic stdio and HTTP client contracts with explicit security metadata                     | Remote MCP servers and their tools remain untrusted external systems.                |
| OpenTelemetry               | Opt-in, metadata-only-by-default adapter tests                                                    | Host configuration can change what is exported and must be reviewed.                 |

The precise commands, dates, digests, and known gaps live in the
[`v0.1 readiness record`](docs/releases/v0.1-readiness.md). That record is
deliberately more conservative than a feature checklist.

## Release integrity

Pactmark's release path is designed so publication authority does not depend on
a long-lived npm token in the repository.

- npm publication uses GitHub Actions OIDC trusted publishing.
- Release candidates run `pnpm verify` before publication.
- All packages are packed and inspected as independent consumer artifacts.
- Candidate tarballs are reproduced and compared before acceptance.
- The release contains SHA-256 checksums, source/release manifests, a CycloneDX
  SBOM, npm provenance, and GitHub attestations.
- The public v0.1.2 tarballs were fetched anonymously and matched to the frozen
  release manifest.

Inspect the immutable [v0.1.2 release](https://github.com/lokomotifai/pactmark/releases/tag/v0.1.2)
or read the [release evidence](docs/releases/v0.1-readiness.md). Provenance tells
you where an artifact came from; it does not certify the artifact's behavior.

## Develop the repository

Pactmark development uses Node.js 24 and pnpm 11.18.0. Node.js 22.14+ and 24.x
are the supported release lines.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Use `pnpm check` for the normal edit loop, `pnpm verify:ci` for the deterministic
pull-request surface, and `pnpm verify` before a release. The release aggregate is a material gate:
formatting, lint, strict types, builds, unit
and integration suites, packed consumers, portability, examples, PostgreSQL,
crash/replay behavior, OCI and platform contracts, API reports, dependency
boundaries, security audits, SBOM, documentation, and release dry-run. Live
provider calls, external deployments, and network-fresh advisory checks remain
separate authorized gates.

For a smaller loop, use the package's focused test and typecheck commands. See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Public failures use the legacy `KAF_*` v0.1 wire-code namespace. It remains stable for consumer
compatibility and does not name a separate product; clients must treat each complete code as an
opaque identifier.

## Community contract

Pactmark is founder-led today, with a governance model designed to become less
centralized only when real contributors are ready to hold explicit scopes.
There are no fictional committees and no automatic promotion by contribution
count.

| Document                              | What it commits the project to                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Contributing](CONTRIBUTING.md)       | Reproducible setup, review standard, DCO sign-off, AI-assisted contribution policy, and acceptance criteria.  |
| [Governance](GOVERNANCE.md)           | Roles, decision classes, public RFC/ADR path, conflicts, maintainer transitions, and founder-led limitations. |
| [Maintainers](MAINTAINERS.md)         | Named people, scopes, sensitive capabilities, and verified contact routes.                                    |
| [Code of Conduct](CODE_OF_CONDUCT.md) | Participation standards, private reporting, conflicts, and a proportionate response ladder.                   |
| [Security](SECURITY.md)               | Supported versions, private reporting, response targets, safe harbor, and security boundaries.                |
| [Support](SUPPORT.md)                 | Correct help route, useful reproduction data, and the project's support boundary.                             |
| [Roadmap](ROADMAP.md)                 | Current direction and the capabilities Pactmark intentionally does not promise.                               |
| [Name and logo policy](TRADEMARKS.md) | Fair community use without implying endorsement or official status.                                           |

Commits require [DCO 1.1](https://developercertificate.org/) sign-off. The
project uses no Contributor License Agreement. Contributions of code,
documentation, translation, review, triage, test design, and community care are
all meaningful.

## Documentation and examples

- [Documentation home](docs/index.md)
- [Türkçe dokümantasyon](docs/tr/index.md)
- [Build your first agent](docs/getting-started/first-agent.md)
- [Concepts: agent and WorkOrder](docs/concepts/agent-and-work-order.md)
- [Concepts: tools, risk, and grants](docs/concepts/tools-risk-and-capability-grants.md)
- [Run lifecycle and durability](docs/concepts/run-lifecycle-and-durability.md)
- [Approval agent](examples/approval-agent/) — a simulated outbound effect with
  a real approval boundary and no live provider.
- [Node quickstart](apps/node-quickstart/) — HTTP/SSE and lifecycle behavior.
- [Next.js/Vercel fixture](apps/nextjs-vercel/) — auth, routes, and UI boundary.
- [Cloudflare Worker fixture](apps/cloudflare-worker/) — experimental ephemeral
  edge profile with honest readiness.

## License

Source code is available under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) and [ORIGIN_AND_ATTRIBUTION.md](ORIGIN_AND_ATTRIBUTION.md) for
attribution. The Pactmark name and logo are governed separately by
[TRADEMARKS.md](TRADEMARKS.md); the license does not grant a right to imply that
a modified distribution is an official Pactmark release.

---

<p align="center"><strong>Bound the work. Keep authority outside the model. Verify the result.</strong></p>
