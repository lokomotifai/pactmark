# Origin and attribution

Pactmark is an original implementation informed by publicly available ideas
and documentation. It is not represented as a legal clean-room implementation.

## Design references

The following projects informed architectural comparison only. Their source,
fixtures, documentation text, and APIs are not incorporated into Pactmark by
that fact alone:

- [Mastra](https://github.com/mastra-ai/mastra): TypeScript developer
  experience, composable adapters, evaluations, and observability.
- [Eve](https://github.com/vercel/eve): checkpointing, replay, idempotency,
  sandbox boundaries, and parked work.
- [Flue](https://github.com/withastro/flue): headless harnesses, portable
  adapters, and durable-execution design.

Each project remains governed by its own license and notices. Referencing it
here grants no rights beyond those terms.

## Incorporated material register

### Contributor Covenant 2.1

- Material: the structure and core behavioral standards adapted in
  `CODE_OF_CONDUCT.md`.
- Source: <https://www.contributor-covenant.org/version/2/1/code_of_conduct.html>
- Upstream author: Contributor Covenant contributors.
- License: Creative Commons Attribution 4.0 International (CC BY 4.0).
- Treatment: adapted and shortened; attribution and license link are retained
  in `CODE_OF_CONDUCT.md` and this register.
- NOTICE handling: no Apache NOTICE insertion is required; the attribution is
  carried with the adapted document.

### Pactmark logo

- Material: `assets/brand/pactmark-logo.svg` and the mechanically rendered PNG.
- Source: project artwork supplied by the repository owner for publication on
  2026-08-05; no external source was identified.
- Treatment: geometry and colors preserved; accessible SVG metadata added.
- License treatment: official project identity asset governed by
  `TRADEMARKS.md`, not offered as a third-party asset under the repository's
  Apache-2.0 grant.

The explanatory README diagrams are original project documentation authored as
SVG in this repository. Their PNG files are mechanical renders of those sources
and add no separate attribution requirement.

Before incorporating third-party material, a contributor must add a register
entry containing:

- the material and destination paths;
- the upstream author, canonical source URL, commit or immutable version;
- the upstream license and compatibility review;
- whether the material was copied, modified, generated, or derived;
- required attribution and NOTICE handling; and
- the reviewing maintainer and review date.

Ordinary package dependencies are not copied into this register merely by
being linked at build or runtime. They remain visible through package metadata,
lockfiles, license review, and the release SBOM.
