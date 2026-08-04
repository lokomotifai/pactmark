# Research evidence agent

This example turns a deterministic source fixture into a verified artifact and Pactmark `EvidenceRecord`.

```sh
pnpm --filter pactmark-example-research-evidence-agent test
pnpm --filter pactmark-example-research-evidence-agent typecheck
pnpm --filter pactmark-example-research-evidence-agent build
pnpm --filter pactmark-example-research-evidence-agent dev
```

Fixture mode is offline and mandatory in CI. `createExternalSearchAdapter` fails closed unless live access is explicitly enabled, and this repository ships no provider implementation. Citation shape, digest integrity, and fixture support do not prove that a live URL exists, that an external source is authoritative, or that the conclusion is complete.
