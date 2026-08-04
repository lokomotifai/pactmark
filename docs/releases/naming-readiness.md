# Pactmark naming readiness

Status: `KAF_NAMING_FREEZE_APPROVED`; GitHub and npm organization authority verified

Checked: 2026-08-03 public search; 2026-08-04 authenticated GitHub and npm inspection

Check type: public registry search plus authenticated repository/organization inspection and authorized organization creation

The user selected **Pactmark** as the framework name. Local implementation therefore uses these provisional technical names:

- package scope: `@pactmark/*`;
- initializer package: `create-pactmark`;
- CLI binary: `pactmark`;
- generated manifest directory: `.pactmark/generated/`.

These exact strings were approved for the local naming freeze on 2026-08-04 and are
recorded in `docs/releases/naming-decision.md`. Approval is not proof of ownership or
authorization to publish.

## npm evidence

The following exact read-only commands were evaluated against `https://registry.npmjs.org/`:

```text
npm view pactmark --json --registry=https://registry.npmjs.org/
npm view create-pactmark name version maintainers repository dist-tags --json --registry=https://registry.npmjs.org/
npm view <each @pactmark package candidate> name version maintainers repository dist-tags --json --registry=https://registry.npmjs.org/
```

`pactmark`, `create-pactmark`, and all 18 planned scoped leaf packages returned `E404` at check time. Exact registry searches also returned zero objects:

- [`scope:pactmark` search](https://registry.npmjs.org/-/v1/search?text=scope%3Apactmark&size=250), response timestamp `2026-08-03T09:44:43.021Z`;
- [`pactmark` search](https://registry.npmjs.org/-/v1/search?text=pactmark&size=20), response timestamp `2026-08-03T09:45:01.038Z`.

Candidate scoped packages checked:

```text
@pactmark/core
@pactmark/policy
@pactmark/evidence
@pactmark/runtime
@pactmark/agent
@pactmark/executor-in-process
@pactmark/ai-sdk
@pactmark/mcp
@pactmark/store-memory
@pactmark/store-postgres
@pactmark/driver-postgres-worker
@pactmark/http
@pactmark/node
@pactmark/vercel
@pactmark/cloudflare
@pactmark/otel
@pactmark/testing
@pactmark/cli
```

No package collision was observed in the time-bound public search. On 2026-08-04, authenticated npm browser inspection verified owner `fatihguner` with Komünite-branded package metadata, publishing-capable 2FA, and one registered security key. The authorized workflow created the free public-package organization [`pactmark`](https://www.npmjs.com/org/pactmark), enabled organization-wide 2FA enforcement, and verified one owner/member with 2FA, zero members without 2FA, a default `developers` team, zero packages, and a `$0` monthly bill.

The organization establishes control of the `@pactmark` scope. It does not reserve the unscoped `create-pactmark` initializer or publish any scoped package. No token, trusted publisher, package transfer, paid plan, or registry release was created.

## GitHub evidence

Anonymous exact searches returned no public match at check time:

- [`pactmark` user](https://api.github.com/users/pactmark): 404;
- [`pactmark` organization](https://api.github.com/orgs/pactmark): 404;
- `GET https://api.github.com/repos/pactmark/pactmark`: 404;
- [login search](https://api.github.com/search/users?q=pactmark%20in%3Alogin&per_page=100): zero results;
- [repository-name search](https://api.github.com/search/repositories?q=pactmark%20in%3Aname&per_page=100): zero results.

On 2026-08-04, authenticated GitHub inspection established that `fatihguner` is an
active admin of organization `pactmark`. The authorized workflow created the
initially empty public repository [`pactmark/pactmark`](https://github.com/pactmark/pactmark).
Separate source-publication authorization then pushed 733 reviewed files in root
commit `3234ae5e0d5e7855d67aa3010cd2a12f88e86d3d` to the default `main` branch. No tag,
release, package publication, or deployment was created. The repository ID is
`1322668131`; its canonical HTTPS clone URL is
`https://github.com/pactmark/pactmark.git`. The local checkout uses that exact URL as
`origin`.

ChatGPT Codex Connector installation `151134458` is limited to that single
repository and reports admin/push access. All 19 publishable package manifests now
carry exact release-profile metadata with
`git+https://github.com/pactmark/pactmark.git` and their real package directory.

## Collision and authority assessment

- Public npm package collision at check time: not observed.
- Public GitHub exact-name collision at check time: not observed.
- npm organization and `@pactmark` scope ownership: verified 2026-08-04.
- npm package publication authority: not exercised; zero packages and no trusted publisher exist.
- Unscoped `create-pactmark` ownership: unreserved and subject to a time-sensitive collision check before bootstrap.
- Local GitHub owner/repository naming decision: approved as `pactmark/pactmark`.
- GitHub owner/repository authority and existence: verified 2026-08-04.
- Trademark/legal clearance: not performed.
- External mutation performed: public repository and `main` branch created; 733
  source files pushed; Codex App installed and restricted to that repository; npm
  organization `pactmark` created on the free plan with enforced 2FA; no tag,
  GitHub Release, npm package publication, trusted publisher, or deployment.

GitHub release-profile identity and npm organization ownership are now established.
Before package publication, the authenticated npm owner must separately authorize the
package bootstrap and trusted-publisher writes. The unscoped initializer search and
all other public searches are time-sensitive and must be repeated immediately before
any authorized release operation. The approved trademark posture remains the cautious
limitation in `TRADEMARKS.md`, not a clearance finding.
