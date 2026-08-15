# External repository settings status

Checked: `2026-08-15T14:47:46Z`

## Current transferred state

The public repository is [`lokomotifai/pactmark`](https://github.com/lokomotifai/pactmark), retaining repository ID `1324042084`, public visibility, default branch `main`, and canonical clone URL `https://github.com/lokomotifai/pactmark.git`. The old `pactmark/pactmark` web and clone coordinates redirect to the transferred repository. The local checkout uses the canonical new URL as `origin`.

The transferred repository retains bypass-free `main` and `v*` rulesets, immutable releases, private vulnerability reporting, secret scanning and push protection, Dependabot security updates, the reviewer-gated `release` environment, squash/rebase-only merging, and merged-branch cleanup. Wiki and GitHub Pages are disabled.

All 19 npm packages remain under the unchanged `pactmark` organization and `@pactmark/*` scope; no `@lokomotifai/*` package was created. Their trusted publisher is now repository `lokomotifai/pactmark`, workflow `release.yml`, environment `release`, with publish-only permission. Protected run [`31815956264`](https://github.com/lokomotifai/pactmark/actions/runs/31815956264) published `0.1.2` from exact source `87ed7e74177b2a1f43c41d1771307fe6e12398a0`; anonymous verification matched 19/19 registry tarballs, repository metadata, `latest` tags, and SLSA provenance records. Immutable 26-asset GitHub Release [`v0.1.2`](https://github.com/lokomotifai/pactmark/releases/tag/v0.1.2) resolves to that source.

Protected run [`31886596018`](https://github.com/lokomotifai/pactmark/actions/runs/31886596018)
subsequently published `0.2.0` from exact source
`f79611a4573e405fbd7e85699a861c5a087a766d`. Independent anonymous verification
matched 19/19 registry tarballs, repository metadata, `latest` tags, and SLSA
provenance records. Immutable 26-asset GitHub Release
[`v0.2.0`](https://github.com/lokomotifai/pactmark/releases/tag/v0.2.0) resolves to
that source. These release controls do not constitute a production deployment or
security certification.

ChatGPT Codex Connector installation `153748209` is installed on `lokomotifai` and restricted to the single `lokomotifai/pactmark` repository. Connector inspection reports admin, maintain, pull, push, and triage access. The GitHub CLI remains authenticated as `fatihguner`; the temporary npm CLI session used to migrate trusted publishers was logged out and no npm authentication entry remains in the user npm configuration.

## Historical bootstrap state

At the 2026-08-05 check, the public repository existed as [`pactmark/pactmark`](https://github.com/pactmark/pactmark) under the owner-controlled `pactmark` organization. Authenticated inspection recorded `fatihguner` as an active organization admin, repository visibility `PUBLIC`, canonical HTTPS clone URL `https://github.com/pactmark/pactmark.git`, default branch `main`, and viewer permission `ADMIN`. The local checkout used that exact URL as `origin`.

ChatGPT Codex Connector installation `151134458` was installed on `pactmark` and limited to the single `pactmark/pactmark` repository. Connector inspection reported admin, maintain, pull, push, and triage access for that repository. The GitHub CLI was authenticated as `fatihguner` using HTTPS with `repo`, `read:org`, and `workflow` scopes.

After explicit authorization, the old repository was deleted and recreated under the same `pactmark/pactmark` name. The recreated repository has ID `1324042084`, a single reviewed public-source baseline, and no retained old pull requests, Actions runs, tags, or releases. Release PR [#1](https://github.com/pactmark/pactmark/pull/1) squash-merged as commit `c9b5eee7f98a31c17e1031accf9ec473cb1b65e9`.

GitHub Actions CI run [`31011208553`](https://github.com/pactmark/pactmark/actions/runs/31011208553) completed successfully for the release PR source. Ubuntu Node 22.23.2 and 24.18.1 passed the complete canonical gate after explicit digest-pinned sandbox-base bootstrap; Node 24.18.1 macOS and Windows passed the portable-host and independent packed-consumer surface.

Standalone deterministic-security run [`31011208473`](https://github.com/pactmark/pactmark/actions/runs/31011208473) passed before merge. Authenticated inspection verified bypass-free `main` and `v*` rulesets, the four exact required host/runtime checks, resolved-conversation and linear-history requirements, force-push/deletion denial, private vulnerability reporting, immutable releases, squash/rebase-only merging, merged-branch cleanup, and a `release` environment restricted to `main` or `v*` and requiring `fatihguner` approval. Required approval count remains zero while only one maintainer exists; it must increase when an independent maintainer joins.

After explicit npm-organization authorization, authenticated npm browser inspection verified owner `fatihguner` with Komünite-branded package metadata, 2FA for authorization and publishing, and one registered security key. The free `$0` [`pactmark` organization](https://www.npmjs.com/org/pactmark) was created with unlimited public packages. It reports one owner/member, one 2FA-enabled member, zero 2FA-disabled members, active organization-wide 2FA enforcement, the default `developers` team, and 18 scoped public packages; unscoped `create-pactmark` is published under the same owner. All 19 packages retain the same trusted-publisher coordinates for the recreated repository name.

The historical bootstrap state in this section predates the verified public 0.1.0 publication recorded in `naming-readiness.md`. Protected run [`31017765360`](https://github.com/pactmark/pactmark/actions/runs/31017765360) subsequently published v0.1.1 from exact source `54fc96e870d73625c3b81e27f8aff490194c5876` through npm trusted publishing. Anonymous verification matched all 19 registry tarballs to the frozen candidate and found SLSA provenance for every package. Annotated tag and immutable 26-asset GitHub Release [`v0.1.1`](https://github.com/pactmark/pactmark/releases/tag/v0.1.1) resolve to that source.

The temporary GitHub OAuth `delete_repo` scope used for the authorized repository replacement was removed after final verification. Active CLI scopes are `repo`, `read:org`, `workflow`, and `gist`.
