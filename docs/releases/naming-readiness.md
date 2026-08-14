# Pactmark naming readiness

Status: `KAF_PUBLIC_RELEASE_VERIFIED`; GitHub Release, npm authority, package bytes, and public initializer verified

Checked: 2026-08-03 public search; 2026-08-04 authenticated GitHub and npm inspection; 2026-08-05 guarded npm publication, public consumer acceptance, immutable GitHub Release, and test-resource teardown; 2026-08-14 repository transfer, trusted-publisher migration, and verified v0.1.2 release

Check type: public registry search, authenticated repository/organization inspection, guarded exact-candidate publication, anonymous registry-byte verification, and independent public consumer acceptance

The user selected **Pactmark** as the framework name. The verified public release uses these frozen technical names:

- package scope: `@pactmark/*`;
- initializer package: `create-pactmark`;
- CLI binary: `pactmark`;
- generated manifest directory: `.pactmark/generated/`.

These exact strings were approved for the local naming freeze on 2026-08-04 and are
recorded in `docs/releases/naming-decision.md`. The release evidence below separately
proves ownership, publication, and public installation; it does not establish
trademark or legal clearance.

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

The organization inspection established control of the `@pactmark` scope before
publication. At that point it did not reserve the unscoped initializer or create a
package, token, trusted publisher, paid plan, or registry release.

### Verified public release

On 2026-08-05, the guarded publisher consumed the GitHub-attested candidate from
pre-recreation protected run `30981599698` for source commit
`e19713506097803a1eaff08c7c93711a34151c9f`. The candidate release-manifest
SHA-256 is
`8bc1402b4e41539bdcf7cb9a6aa002b364fb83e80b0655f442706d274e9b741a`.
Before the first write, all 19 exact names returned anonymous 404 responses. The
human-attended npm 11.18.0 bootstrap authenticated `fatihguner` with WebAuthn,
published the 18 scoped packages dependency-first and `create-pactmark` last,
then logged out.

An independent anonymous gate at `2026-08-05T09:34:33.267Z` fetched every
registry-served tarball, matched all 19 SHA-256 values to the attested candidate,
and verified `latest=0.1.0` for every package. This interactive bootstrap does
not carry npm provenance; no provenance claim is made for `0.1.0`.

All 19 packages initially received the same npm trusted publisher:
`pactmark/pactmark`, workflow filename `release.yml`, GitHub environment
`release`, with package publication as the sole permission. Traditional publishing is
set to `mfa=publish`, which requires 2FA and sets
`automation_token_overrides_tfa=false`. No long-lived npm automation token was
created or retained.

Independent clean-directory acceptance ran both
`npm create pactmark@0.1.0 -- my-agent ...` and
`npm create pactmark@latest -- my-agent ...`. Both resolved framework version
`0.1.0`, installed 142 dependencies with zero reported vulnerabilities,
generated identical source digests, compiled successfully, and passed two of two
generated tests. The library template's unconfigured production doctor failed
closed with `KAF_CLI_HOST_NOT_CONFIGURED`, as designed.

### Verified v0.1.1 trusted release

Protected release run [`31017765360`](https://github.com/pactmark/pactmark/actions/runs/31017765360) completed for exact source `54fc96e870d73625c3b81e27f8aff490194c5876`. It used Node 24.18.1, npm 11.18.0, GitHub environment `release`, and the configured trusted-publisher coordinates; no long-lived npm token was created or retained.

All 19 packages resolve `latest` to `0.1.1`. Independent anonymous verification fetched the registry-served bytes for every package, matched each SHA-256 to the frozen release manifest, confirmed the exact repository metadata, and found an npm SLSA provenance record. The annotated [`v0.1.1`](https://github.com/pactmark/pactmark/releases/tag/v0.1.1) tag resolves to the release source, and its immutable GitHub Release retains 26 checksum, package, manifest, SBOM, and attestation assets.

The patch changes repository/release hygiene and trusted-publication execution only. It does not change the v0.1 runtime API or behavior.

### Verified v0.1.2 transferred release

On 2026-08-14, all 19 trusted publishers were migrated in place to repository `lokomotifai/pactmark`, workflow filename `release.yml`, GitHub environment `release`, with package publication as the sole permission. The npm organization remains `pactmark`, the scoped packages remain `@pactmark/*`, and the initializer remains unscoped `create-pactmark`; no `@lokomotifai/*` package was created. The temporary npm CLI login was closed after independent `npm trust list` verification reported 19/19 matching publishers.

Protected release run [`31815956264`](https://github.com/lokomotifai/pactmark/actions/runs/31815956264) completed for exact source `87ed7e74177b2a1f43c41d1771307fe6e12398a0`. All 19 packages resolve `latest` to `0.1.2`. Independent anonymous verification fetched the registry-served bytes for every package, matched each SHA-256 to the frozen release manifest, confirmed exact `git+https://github.com/lokomotifai/pactmark.git` repository metadata and package directories, and found an npm SLSA provenance record for every package.

Annotated [`v0.1.2`](https://github.com/lokomotifai/pactmark/releases/tag/v0.1.2) resolves to the release source. Its immutable GitHub Release retains 26 checksum, package, manifest, SBOM, and attestation assets. The public v0.1 runtime API and the 19-package npm surface remain unchanged.

## GitHub evidence

Anonymous exact searches returned no public match at check time:

- [`pactmark` user](https://api.github.com/users/pactmark): 404;
- `pactmark` organization API lookup: 404 at the historical check time;
- `GET https://api.github.com/repos/pactmark/pactmark`: 404;
- [login search](https://api.github.com/search/users?q=pactmark%20in%3Alogin&per_page=100): zero results;
- [repository-name search](https://api.github.com/search/repositories?q=pactmark%20in%3Aname&per_page=100): zero results.

On 2026-08-04, authenticated GitHub inspection established that `fatihguner` is an
active admin of organization `pactmark`. On 2026-08-05, the repository was deliberately
deleted and recreated under the exact same public name
[`pactmark/pactmark`](https://github.com/pactmark/pactmark), with a single reviewed
public-source baseline and no retained old pull requests, Actions runs, tags, or releases.
The recreated repository ID is `1324042084`; its canonical HTTPS clone URL is
`https://github.com/pactmark/pactmark.git`. The local checkout uses that exact URL as
`origin`.

The old repository's annotated `v0.1.0` tag and immutable 26-asset GitHub Release
were removed as part of that deletion and are not represented as live evidence in
the recreated repository. The npm `0.1.0` packages and their verified registry bytes
were unaffected by the GitHub recreation.

At that time, ChatGPT Codex Connector installation `151134458` was limited to that
single repository and reported admin/push access. All 19 publishable package
manifests carried exact release-profile metadata with
`git+https://github.com/pactmark/pactmark.git` and their real package directory.

### 2026-08-14 repository transfer outcome

The same repository ID `1324042084` now resolves canonically as [`lokomotifai/pactmark`](https://github.com/lokomotifai/pactmark), with clone URL `https://github.com/lokomotifai/pactmark.git`; the old web and clone coordinates redirect. ChatGPT Codex Connector installation `153748209` is installed on `lokomotifai`, restricted to the single transferred repository, and reports admin, maintain, pull, push, and triage access. The 19 publishable manifests and verified `0.1.2` registry metadata use the new canonical repository URL and the unchanged package directories.

## Collision and authority assessment

- Public npm package collision at check time: not observed.
- Public GitHub exact-name collision at check time: not observed.
- npm organization and `@pactmark` scope ownership: verified 2026-08-04.
- npm package publication authority: exercised through the guarded interactive bootstrap; 19 exact `0.1.0` packages are public and byte-verified.
- npm trusted publishing: verified for all 19 packages with the exact GitHub workflow/environment and publish-only permission.
- Traditional npm token publishing: bypass tokens disallowed for all 19 packages; interactive 2FA remains required.
- Unscoped `create-pactmark` ownership: established by the verified public `0.1.0` release.
- Local GitHub owner/repository naming decision: amended and verified as `lokomotifai/pactmark`.
- GitHub owner/repository authority and existence: verified after transfer on 2026-08-14.
- Trademark/legal clearance: not performed.
- External mutation performed: public repository and protected `main` branch
  created; source published; Codex App restricted to that repository; npm
  organization `pactmark` created on the free plan with enforced 2FA; 19 public
  packages published and byte-verified; 19 trusted publishers configured; token
  bypass disabled; exact-candidate Vercel Preview verified. The pre-recreation
  immutable `v0.1.0` tag and 26-asset GitHub Release were removed with the old
  repository. The test-only Vercel project was
  subsequently removed and verified absent. The recorded Neon test-project ID was
  already absent; a separately observed empty Pactmark Neon project was removed
  only after exact-target approval, after which the organization reported no
  projects.

GitHub release-profile identity and immutable v0.1.2 Release, npm organization
ownership, public package publication, per-package SLSA provenance, trusted
publishing, and exact/latest initializer identity are now established. The approved
trademark posture remains the cautious limitation in `TRADEMARKS.md`, not a
clearance finding.
