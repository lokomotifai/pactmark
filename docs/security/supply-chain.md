---
title: Supply chain
description: Build deterministic candidates and separate local evidence from publication.
---

> Compatibility: Pactmark 0.2.x.

The pinned pnpm lockfile is dependency authority. Lifecycle scripts are denied by
default and reviewed exceptions are versioned. The offline advisory gate verifies
an integrity-protected export bound to the exact lockfile; it does not turn that
historical export into a current-vulnerability claim or expire deterministic CI by
wall-clock age. Any lockfile change requires a fresh network-authorized export.
License gates, immutable workflow refs, secret audits, dependency boundaries, and
public-surface checks run locally.

One canonical packer stages allowlisted files, materializes exact internal versions,
disables lifecycle scripts, and requires a second byte-identical tarball. Independent
NodeNext, Bundler, Yarn, Bun, and loopback-registry fixtures consume packed bytes.

Release dry-run produces checksums, CycloneDX SBOM, manifests, and attestation input
without signing or publishing. Provenance and public registry claims require the
authorized GitHub release path and exact anonymous byte verification.

The protected `release.yml` candidate job is manual, `main`-only, and bound to the
reviewer-gated `release` environment. It reruns deterministic and live freshness
gates, freezes exact tarball/SBOM/manifest checksum subjects, and uploads a candidate
only after GitHub build-provenance and SBOM attestations succeed. Its npm write is
source-bound, reviewer-gated, token-free trusted publishing; the workflow cannot
deploy, create a tag, or create a GitHub Release. The initial 0.1.0 bootstrap used a
human-attended 2FA session. The v0.1.1 patch then verified all existing bytes before
publishing missing exact tarballs and independently matched all 19 registry-served
tarballs to the frozen candidate. After the repository transfer, v0.1.2 repeated
that exact-byte and provenance verification for all 19 packages under the new
`lokomotifai/pactmark` source coordinate. Protected run
[`31886596018`](https://github.com/lokomotifai/pactmark/actions/runs/31886596018)
published v0.2.0 from exact source `f79611a4573e405fbd7e85699a861c5a087a766d`;
independent anonymous verification matched all 19 registry tarballs, `latest` tags,
repository metadata, and SLSA provenance records to the frozen manifest retained by
the immutable [v0.2.0 release](https://github.com/lokomotifai/pactmark/releases/tag/v0.2.0).
