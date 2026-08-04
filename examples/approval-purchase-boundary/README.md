# Approval-bound purchase boundary

The current public facade supports read tools only and does not expose decision
challenge, approval, write-effect, or reconciliation commands. This executable
example therefore demonstrates the honest boundary: it creates an exact R4
policy identity and deterministic purchase preview, then refuses dispatch with
`KAF_EXAMPLE_APPROVAL_SURFACE_UNAVAILABLE`. No purchase or external write occurs.

```sh
pnpm --filter pactmark-example-approval-purchase test
pnpm --filter pactmark-example-approval-purchase dev
```

This is not an approval-flow success claim. A complete approval agent remains
blocked on the public write-effect and authenticated decision APIs.
