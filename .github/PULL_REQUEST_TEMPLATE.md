## Outcome

What observable user, contributor, or maintainer outcome does this change create?
Link the issue or proposal when one exists.

## Scope and contracts

List the affected packages, public APIs or schemas, persisted formats, adapters,
documentation surfaces, and explicit non-goals.

## Authority and risk

Describe implications for policy, grants, approval, credentials, tenancy,
privacy, external effects, evidence, compatibility, dependencies, or releases.
Write `None identified` only after considering each boundary.

## Verification

List exact commands and observable results. Include denial, malformed input,
replay, cancellation, concurrency, or crash-boundary evidence when relevant.

```text
command → result
```

## Documentation and release

- Changeset: <!-- included / not required because ... -->
- English/Turkish parity: <!-- updated / not affected because ... -->
- Migration or upgrade note: <!-- link / not required because ... -->

## AI assistance

<!-- If a generative tool produced a substantial portion of retained code, prose, or assets, say so and explain how you verified it. Otherwise write "No material generated content retained." Do not paste private prompts. -->

## Checklist

- [ ] The change is focused and follows accepted ADRs, or its material decision was proposed first.
- [ ] External input is runtime-validated and no secret, credential, customer data, or private prompt is committed.
- [ ] Tests cover the success path and relevant failure, replay, cancellation, concurrency, and crash behavior.
- [ ] Public claims do not exceed executable evidence.
- [ ] Documentation, examples, accessibility, and required Turkish parity are updated.
- [ ] A Changeset is included when release policy requires one, or the omission is explained above.
- [ ] Every commit has a DCO `Signed-off-by` line (`git commit -s`).
- [ ] I ran the smallest relevant checks and recorded anything I could not run.
