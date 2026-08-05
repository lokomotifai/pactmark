# Pactmark naming readiness

Status: `KAF_PUBLIC_RELEASE_VERIFIED`; GitHub Release, npm authority, package bytes, and public initializer verified

Checked: 2026-08-03 public search; 2026-08-04 authenticated GitHub and npm inspection; 2026-08-05 guarded npm publication, public consumer acceptance, immutable GitHub Release, and test-resource teardown

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
protected run
[`30981599698`](https://github.com/pactmark/pactmark/actions/runs/30981599698)
for source commit
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

All 19 packages now have the same npm trusted publisher:
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

On 2026-08-05, annotated tag `v0.1.0` was created and remotely verified to
dereference exactly to release source commit
`e19713506097803a1eaff08c7c93711a34151c9f`. The public latest
[Pactmark 0.1.0 GitHub Release](https://github.com/pactmark/pactmark/releases/tag/v0.1.0)
is immutable and contains 26 uploaded assets: all 19 exact package tarballs,
`SHA256SUMS`, release/source manifests, the CycloneDX SBOM, attestation input,
and provenance/SBOM attestation bundles. GitHub's asset digest for
`release-manifest.json` is the expected
`sha256:8bc1402b4e41539bdcf7cb9a6aa002b364fb83e80b0655f442706d274e9b741a`.

ChatGPT Codex Connector installation `151134458` is limited to that single
repository and reports admin/push access. All 19 publishable package manifests now
carry exact release-profile metadata with
`git+https://github.com/pactmark/pactmark.git` and their real package directory.

## Collision and authority assessment

- Public npm package collision at check time: not observed.
- Public GitHub exact-name collision at check time: not observed.
- npm organization and `@pactmark` scope ownership: verified 2026-08-04.
- npm package publication authority: exercised through the guarded interactive bootstrap; 19 exact `0.1.0` packages are public and byte-verified.
- npm trusted publishing: verified for all 19 packages with the exact GitHub workflow/environment and publish-only permission.
- Traditional npm token publishing: bypass tokens disallowed for all 19 packages; interactive 2FA remains required.
- Unscoped `create-pactmark` ownership: established by the verified public `0.1.0` release.
- Local GitHub owner/repository naming decision: approved as `pactmark/pactmark`.
- GitHub owner/repository authority and existence: verified 2026-08-04.
- Trademark/legal clearance: not performed.
- External mutation performed: public repository and protected `main` branch
  created; source published; Codex App restricted to that repository; npm
  organization `pactmark` created on the free plan with enforced 2FA; 19 public
  packages published and byte-verified; 19 trusted publishers configured; token
  bypass disabled; exact-candidate Vercel Preview verified; immutable `v0.1.0`
  tag and 26-asset GitHub Release published. The test-only Vercel project was
  subsequently removed and verified absent. The recorded Neon test-project ID was
  already absent; a separately observed empty Pactmark Neon project was removed
  only after exact-target approval, after which the organization reported no
  projects.

GitHub release-profile identity and immutable Release, npm organization ownership,
public package publication, trusted publishing, and exact/latest initializer
behavior are now established. The approved trademark posture remains the cautious
limitation in `TRADEMARKS.md`, not a clearance finding.
