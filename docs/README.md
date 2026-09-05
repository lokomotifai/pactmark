# Project records

Pactmark's public product documentation is maintained separately and published
at [pactmark-docs.lokomotif.ai](https://pactmark-docs.lokomotif.ai). Turkish
documentation is available at
[pactmark-docs.lokomotif.ai/tr](https://pactmark-docs.lokomotif.ai/tr).

This directory is not a second documentation website. It retains only the
version-controlled engineering records needed to design, secure, govern, and
release the framework:

- `adr/` records accepted architectural decisions.
- `architecture/` records dependency and product-boundary rationale.
- `community/` records contributor and RFC processes.
- `releases/` records release gates and observable evidence.
- [`security/`](./security/README.md) is the public, self-contained security
  model: trust boundaries, threats, residual risks, supply-chain controls,
  response procedures, and drills.

Product guides, API references, and translations are also published on the
canonical documentation site. That separate site may be more convenient, but
it is not authoritative for source-level security review: the repository's
[`SECURITY.md`](../SECURITY.md), [`AGENTS.md`](../AGENTS.md), security records,
ADRs, executable tests, and release-readiness record remain available to every
Apache-2.0 contributor.
