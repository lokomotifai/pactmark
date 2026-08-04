## Outcome

Describe the user-visible or maintainer-visible result and the reason for it.

## Scope and risk

List affected packages/contracts and any authority, privacy, tenant, effect,
evidence, compatibility, dependency, or release implications.

## Verification

List the exact commands run and their observable result. Include focused
failure/replay tests where relevant.

## Limitations

State what this change does not prove or support.

## Checklist

- [ ] The change is focused and follows existing ADRs or includes the required RFC/ADR.
- [ ] Untrusted inputs are validated and no secret or private/customer data is committed.
- [ ] Tests cover success and relevant failure, replay, or concurrency behavior.
- [ ] Public docs/examples and required Turkish companion content are aligned where applicable.
- [ ] A Changeset is included when release policy requires one, or the omission is explained.
- [ ] Every commit has a DCO `Signed-off-by` line (`git commit -s`).
- [ ] I ran the relevant checks, including `pnpm verify` when the full gate is available.
- [ ] I documented any external repository, deployment, or release setting that remains unverified.
