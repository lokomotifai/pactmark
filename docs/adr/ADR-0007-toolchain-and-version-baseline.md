# ADR-0007: Toolchain and version baseline

- Status: Accepted; repository documentation-tooling section superseded 2026-08-15
- Date: 2026-08-03
- Decision owners: Pactmark maintainers

## Context

Pactmark publishes typed ESM packages, tests multiple Node.js and TypeScript
consumer profiles, and prepares reproducible, provenance-capable releases.
Mutable or prerelease tooling would weaken repeatability. Tool versions must
also agree on engines and peer ranges rather than merely being independently
current.

## Decision

The repository uses pnpm and Turborepo, develops and releases on Node.js 24,
and continuously tests supported Node.js 22 and 24 profiles. Dependencies are
exactly pinned in the workspace lockfile. Core and release paths do not use
beta, RC, nightly, Git URL, mutable branch, or wildcard dependencies.

The baseline was checked on 2026-08-03 against the official Node.js distribution
index, npm trusted-publishing documentation, pnpm build settings,
typescript-eslint compatibility documentation, and exact npm registry package
metadata. Package manifests and the lockfile are authoritative for installed
bytes; this table records the accepted selection and compatibility intent.

| Purpose                           | Package/tool                   | Exact baseline |
| --------------------------------- | ------------------------------ | -------------- |
| Development and release runtime   | Node.js                        | `24.18.1`      |
| Supported CI runtime              | Node.js                        | `22.23.2`      |
| Guarded release CLI               | npm                            | `12.0.2`       |
| Workspace package manager         | pnpm                           | `11.18.0`      |
| Operational compiler              | TypeScript                     | `6.0.3`        |
| Current-stable consumer lane      | TypeScript                     | `7.0.2`        |
| Monorepo orchestration            | `turbo`                        | `2.10.8`       |
| TypeScript runner                 | `tsx`                          | `4.23.5`       |
| Test runner                       | `vitest`                       | `4.1.10`       |
| Coverage                          | `@vitest/coverage-v8`          | `4.1.10`       |
| Property tests                    | `fast-check`                   | `4.9.0`        |
| Runtime schemas                   | `zod`                          | `4.4.3`        |
| ESM build and declarations        | `tsdown`                       | `0.22.14`      |
| Lint engine                       | `eslint`                       | `10.8.0`       |
| ESLint base configuration         | `@eslint/js`                   | `10.0.1`       |
| TypeScript lint integration       | `typescript-eslint`            | `8.65.0`       |
| Formatting                        | `prettier`                     | `3.9.6`        |
| ESLint/Prettier compatibility     | `eslint-config-prettier`       | `10.1.8`       |
| Release/version intent            | `@changesets/cli`              | `2.31.1`       |
| Dependency boundaries             | `dependency-cruiser`           | `18.1.1`       |
| Package validation                | `publint`                      | `0.3.22`       |
| Type/package validation           | `@arethetypeswrong/cli`        | `0.18.5`       |
| Unused-code/dependency checks     | `knip`                         | `6.31.0`       |
| API report tooling                | `@microsoft/api-extractor`     | `7.58.12`      |
| Bundle budget                     | `size-limit`                   | `13.0.3`       |
| Small-library budget preset       | `@size-limit/preset-small-lib` | `13.0.3`       |
| Supported-runtime Node typings    | `@types/node`                  | `22.20.1`      |
| MCP adapter SDK                   | `@modelcontextprotocol/sdk`    | `1.30.0`       |
| Optional model adapter SDK        | `ai`                           | `7.0.48`       |
| Direct Vite pin when materialized | `vite`                         | `8.2.0`        |
| Local candidate registry          | `verdaccio`                    | `6.9.2`        |
| Packed consumer package manager   | Yarn                           | `4.18.0`       |
| Packed consumer runtime/manager   | Bun                            | `1.3.14`       |
| Next.js host fixture              | `next`                         | `16.2.12`      |
| Cloudflare local/dry-run CLI      | `wrangler`                     | `4.118.0`      |
| External-only Vercel CLI          | `vercel`                       | `58.4.4`       |

The root compiler remains TypeScript 6.0.3 because
`typescript-eslint@8.65.0` declares TypeScript `>=4.8.4 <6.1.0` and ESLint
`^8.57.0 || ^9.0.0 || ^10.0.0`. TypeScript 7.0.2 runs in a separate consumer
lane and cannot silently replace the operational compiler until the lint stack
supports it and the full repository gate passes.

`tsdown@0.22.14` supports TypeScript 5/6/7 and requires Node.js
`^22.18.0 \|\| >=24.11.0`; both selected Node pins satisfy that engine.
`tsup@8.5.1` was considered but rejected because its upstream project states it
is no longer actively maintained and recommends tsdown.

npm 12.0.2 requires Node.js `^22.22.2 || ^24.15.0 || >=26`, satisfied by the
selected CI and release pins. It also exceeds the npm trusted-publishing floor
of npm 11.5.1 on Node.js 22.14.0 that was documented on the snapshot date. The
protected release job must still re-check the official floor and supported OIDC
command scope immediately before a public release.

Coverage and Vitest remain on the same exact version. Global Node typings use
the Node 22 line to prevent accidental Node 26 API use; a Node-24-only app may
use separately isolated `@types/node@24.13.3` when justified.

pnpm 11 denies undeclared dependency build scripts with
`strictDepBuilds: true` and an explicit `allowBuilds` map. Each allowed entry
needs a version-controlled owner and rationale; the malicious-postinstall
canary is explicitly denied. Removed legacy lifecycle settings are not used.

The latest checked Vercel CLI is intentionally not a workspace dependency. Its
transitive graph reported one critical and multiple high advisories even though
the CLI itself was current. Authorized live deployment commands therefore use
the exact external-only `npx --yes vercel@58.4.4` invocation after a fresh
advisory check; deterministic local verification does not install or execute
that graph. Next's vulnerable transitive `sharp@0.34.5` and `postcss@8.4.31`
edges are overridden to reviewed patched releases `0.35.3` and `8.5.25`; the
clean Next production build is a regression gate for those overrides.

## Version policy

- Exact installed versions are committed in the lockfile; upgrades are
  reviewed changes with the full verification gate.
- Production dependencies must be actively maintained, permissively licensed,
  few, and justified in `docs/architecture/dependencies.md`.
- Platform/provider SDKs stay in optional adapters and do not enter core.
- The AI SDK baseline is isolated in `@pactmark/ai-sdk`; its ready-model path
  is limited to `ambient_preview`, and AI SDK tools never execute Pactmark
  effects.
- CI uses frozen-lockfile installation after the reviewed bootstrap.
- The minimum supported TypeScript version is set only by packed independent
  consumer tests. TypeScript-next/current-future lanes are informative until
  explicitly promoted and cannot block a release by themselves.
- GitHub Actions use full immutable commit SHAs with the source tag recorded in
  a comment.

## Consequences

- A tool release does not enter Pactmark automatically; compatibility and
  supply-chain review precede every update.
- The repository may temporarily use a stable compiler older than the newest
  stable compiler when required by a selected stable lint integration, while
  separately testing the newer consumer lane.
- Release jobs pin Node.js and npm independently instead of assuming the npm
  bundled with an arbitrary runner image is suitable.
- Experimental integrations are isolated, labeled, and removable.
- Public product documentation is maintained in the separate
  `lokomotifai/pactmark-documentation` repository and published at
  `https://pactmark-docs.lokomotif.ai`; this repository no longer carries a
  static documentation application or its build dependencies.

## Primary references

- [Node.js distribution index](https://nodejs.org/dist/index.json)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [pnpm build settings](https://pnpm.io/settings/build)
- [typescript-eslint dependency versions](https://typescript-eslint.io/users/dependency-versions/)
- [tsup maintenance notice](https://github.com/egoist/tsup)
- [AI SDK package metadata](https://registry.npmjs.org/ai)
- [AI SDK `streamText` reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)
