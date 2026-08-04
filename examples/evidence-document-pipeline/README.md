# Evidence document pipeline

This fixture-only pipeline content-addresses a JSON document, verifies exact
bytes and citation shape, builds a claim-bounded EvidenceRecord, and exports
deterministic JSON and Markdown. It performs no live URL fetch. A passing
citation-shape verifier proves neither source availability nor factual truth.

```sh
pnpm --filter pactmark-example-evidence-document test
pnpm --filter pactmark-example-evidence-document dev
```
