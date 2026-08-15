# Dependency policy and rationale

Pactmark keeps production dependencies few, replaceable, permissively licensed,
and isolated to the package that needs them. The lockfile is the exact resolved
dependency record; package manifests declare supported compatibility ranges.
ADR-0007 records the repository toolchain baseline.

## Runtime dependency categories

| Dependency category                 | Owning package                           | Rationale                                                                                      | Boundary                                                                                                  |
| ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Zod                                 | `core` and public schema-owning packages | Runtime validation and TypeScript inference from one v0.1 domain truth                         | No alternative schema abstraction is exposed as domain truth in v0.1; wire formats remain migration-ready |
| Standard Postgres driver            | `store-postgres`                         | Durable stores over a conventional `DATABASE_URL` without binding contracts to a hosted vendor | Never imported by `core`, `runtime`, `agent`, or CLI production code                                      |
| Vercel AI SDK                       | `ai-sdk`                                 | Normalize supported model calls while retaining Pactmark runtime ownership of policy and tools | Optional/peer integration; its types do not enter core APIs                                               |
| Official MCP TypeScript SDK         | `mcp`                                    | Interoperate with MCP using the protocol's maintained implementation                           | Optional and guarded; server metadata/output is untrusted                                                 |
| Production-guarded Executor gateway | `executor-sh`                            | Map reviewed Executor catalog entries to exact read-only Pactmark tool registrations           | Private and removable; depends on `core` and `mcp`, never the reverse                                     |
| OpenTelemetry API                   | `otel`                                   | Emit opt-in, vendor-neutral metadata telemetry                                                 | Optional/peer integration; remote telemetry stays off by default                                          |

Provider clients belong to consuming applications or the relevant adapter as
peer/optional dependencies. Core must not depend on a proprietary model gateway,
provider HTTP client, platform SDK, deployment CLI, telemetry exporter, or
hosted database SDK.

`@pactmark/executor-sh` is a private, production-guarded workspace integration governed by ADR-0008.
It adds no Executor SDK dependency, is excluded from the frozen public package/release set, and must
remain absent from `core`, `runtime`, and the default `agent` facade. Its removal plan is deleting the
leaf package, documentation, and workspace lockfile importer without changing kernel contracts.

## Development and release tooling

- TypeScript provides strict static checking and public declarations.
- A stable ESM build/declaration tool produces publishable output.
- Vitest and fast-check cover examples, invariants, and adversarial properties.
- ESLint, typescript-eslint, and Prettier enforce reviewable source conventions.
- pnpm and Turborepo coordinate the workspace; Changesets records release intent.
- dependency-cruiser enforces production/test import direction.
- publint and `@arethetypeswrong/cli` inspect packed package contracts.
- knip detects unused source and dependencies.
- npm CLI is pinned for tarball and guarded trusted-publishing verification.
- SBOM, license, secret, vulnerability, workflow, and provenance tools are part
  of the release gate even when they are not runtime dependencies.

Development tools execute repository code or inspect release artifacts and are
therefore included in dependency, license, vulnerability, and lifecycle-script
review. A `devDependency` label does not remove supply-chain risk.

During WP-00, `@arethetypeswrong/cli`, API Extractor, fast-check, publint,
tsdown, Turborepo, and Zod are intentionally pinned before their owning public
packages are materialized. The root `pnpm` package mirrors the `packageManager`
pin so repository scripts remain executable where Corepack is absent. These
entries are explicitly excluded from Knip's unused-dependency finding only
until their owning milestone introduces the corresponding package or packed
artifact check; they remain in lockfile, license, lifecycle, and vulnerability
review scope.

## Acceptance rules

A new or upgraded dependency requires review of:

1. the capability it provides and why existing Web/Node primitives or current
   dependencies are insufficient;
2. maintenance activity, release stability, ownership, and compromise risk;
3. license compatibility and required attribution/NOTICE handling;
4. install/build scripts, native binaries, network access, and transitive graph;
5. bundle, startup, portability, and supported-Node impact;
6. exact package ownership and registry source; and
7. an isolation/removal plan if it is an adapter or experimental capability.

Beta, release-candidate, nightly, Git URL, mutable branch, wildcard version,
and mutable GitHub Action dependencies are forbidden in the core/release path.
Experimental adapters must be labeled, isolated, removable, and absent from
core dependency direction.

Lifecycle scripts are denied by default. An exception must be version-controlled
with the exact package, responsible owner, reason, and compensating review. A
malicious-postinstall canary verifies that the default denial remains effective.

The monorepo uses pnpm. Generated consumers support pnpm and npm at minimum;
Yarn 4 and Bun are consumer-conformance targets rather than repository package
managers. Supported TypeScript ranges are proved through packed-consumer tests,
not inferred from a successful monorepo build.
