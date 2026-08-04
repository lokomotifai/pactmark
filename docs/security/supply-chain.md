---
title: Supply chain
description: Build deterministic candidates and separate local evidence from publication.
---

> Compatibility: Pactmark 0.1.x.

The pinned pnpm lockfile is dependency authority. Lifecycle scripts are denied by
default and reviewed exceptions are versioned. Offline advisory and license gates,
immutable workflow refs, secret audits, dependency boundaries, and public-surface
checks run locally.

One canonical packer stages allowlisted files, materializes exact internal versions,
disables lifecycle scripts, and requires a second byte-identical tarball. Independent
NodeNext, Bundler, Yarn, Bun, and loopback-registry fixtures consume packed bytes.

Release dry-run produces checksums, CycloneDX SBOM, manifests, and attestation input
without signing or publishing. Provenance and public registry claims require the
authorized GitHub release path and exact anonymous byte verification.

The protected `release.yml` candidate job is manual, `main`-only, and bound to the
reviewer-gated `release` environment. It reruns deterministic and live freshness
gates, freezes exact tarball/SBOM/manifest checksum subjects, and uploads a candidate
only after GitHub build-provenance and SBOM attestations succeed. It has no npm,
deployment, tag, or GitHub Release write. Brand-new npm packages cannot use staged
publishing or trusted publishing before they exist, so the first public release
remains a later human-attended 2FA bootstrap after the exact-byte Vercel gate.
