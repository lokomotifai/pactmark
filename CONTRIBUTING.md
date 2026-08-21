# Contributing to Pactmark

Pactmark welcomes code, tests, documentation, translations, review, issue
triage, design critique, and reproducible failure reports. Contributions are
judged by the clarity of the problem and the evidence for the outcome—not by
their size or by a contributor's prior visibility.

## Start with the right conversation

- **Small bug or documentation fix:** a focused pull request is welcome.
- **Unclear bug:** open a [bug report](https://github.com/lokomotifai/pactmark/issues/new?template=bug.yml)
  with a minimal reproduction.
- **New capability or public contract change:** open a
  [feature proposal](https://github.com/lokomotifai/pactmark/issues/new?template=feature.yml)
  before implementation.
- **Security vulnerability:** use [private reporting](SECURITY.md), never a
  public issue or pull request.
- **Good first contribution:** look for
  [`good first issue`](https://github.com/lokomotifai/pactmark/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/lokomotifai/pactmark/labels/help%20wanted).

Read the relevant package README, accepted ADRs in `docs/adr/`, and
[product principles](docs/architecture/product-principles.md) before changing a
public contract. Comment on an issue before taking substantial unassigned work;
assignment avoids duplicated effort but does not reserve an issue indefinitely.

## Development setup

Requirements:

- Node.js 24 for development; release CI supports Node.js 22.14+ and 24.x.
- Corepack and the exact pnpm version declared in `package.json`.
- Git, and Docker only for the container/PostgreSQL conformance gates.

```sh
git clone https://github.com/lokomotifai/pactmark.git
cd pactmark
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The lockfile and lifecycle-script allowlist are supply-chain controls. Do not
approve a new install script without documenting the package, owner, purpose,
and review. Required behavior must be testable without a live model key or SaaS
account.

Run the smallest relevant check while iterating. Before requesting final review:

```sh
pnpm check
pnpm verify:ci
```

The release aggregate, `pnpm verify`, is intentionally extensive and is required before
publication. If an environment prevents one
of its host-level checks, run every available focused check and state the exact
unrun command and reason in the pull request; a maintainer decides whether CI
provides the missing evidence.

## Engineering contract

- Keep public code, API names, stable errors, and canonical documentation in
  English. Update required Turkish companion content with semantic and safety
  parity.
- Treat external input as `unknown` until runtime validation succeeds.
- Keep policy, credentials, approvals, budgets, storage, and effect execution
  outside model authority.
- Preserve provider- and platform-neutral kernel boundaries. Vendor behavior
  belongs in adapters.
- Add deterministic success and relevant denial, malformed-input, replay,
  cancellation, concurrency, and crash-boundary tests.
- Use stable `KAF_*` codes for public failures; consumers must not parse English
  messages.
- Do not persist hidden chain-of-thought or place resolved credentials in
  events, context, telemetry, artifacts, evidence, errors, or diagnostics.
- Do not claim exactly-once effects, production isolation, certification, or
  security beyond executable evidence.
- Do not commit credentials, customer or production data, private bootstrap
  inputs, generated caches, or workspace-linked package artifacts.

Public package behavior is accepted from packed tarballs in independent
consumer fixtures, not only from workspace links. Tests may use
`@pactmark/testing` as an explicit development dependency; production exports
must not depend on it.

## Changesets and compatibility

Add a Changeset for a user-visible package change:

```sh
pnpm changeset
```

Use `patch` for backward-compatible fixes, `minor` for backward-compatible
capability, and `major` for incompatible public API changes. Before 1.0, Pactmark
still treats documented public contracts seriously: “minor” is not permission
to break users silently. Pure repository documentation or test-only changes
normally do not need a Changeset; explain the omission in the pull request.

Do not edit generated output when a reproducible source exists. Update examples
and both language surfaces when a change alters documented behavior.

## DCO commit certification

Pactmark uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Every commit must include a sign-off certifying that you have the right to
submit the contribution under the project's license:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Create it with `git commit -s`. A pull-request checkbox does not replace
per-commit sign-off. Amend or rebase your own unsigned commits; do not rewrite
another contributor's certification.

## Contributor License Agreement

Pactmark is preparing an additive Contributor License Agreement for future
contributions. The draft agreements remain pending final legal review and are
not effective until the project announces September 15, 2026 at 00:00 UTC as
the effective date. They do not apply retroactively. See
[`CLA/README.md`](CLA/README.md) for status and scope.

Once effective, the CLA check will ask each non-allowlisted commit author to
accept the individual agreement on their first pull request. Contributors whose
employer owns or controls the relevant rights must contact `legal@lokomotif.ai`
before contributing so signing authority and any Corporate CLA can be verified.

DCO sign-off will still be required on every commit. The CLA does not change
Pactmark's Apache-2.0 license today. It is intended to make the license granted
with future contributions explicit and preserve an option to relicense or
dual-license later; it is not a commitment to use that option.

Pactmark core versions released on or before September 15, 2026 at 00:00 UTC
will remain available under the Apache License 2.0; any different licensing
model for later versions requires the public material-decision process in
GOVERNANCE.md.

## AI-assisted contributions

Tool assistance is allowed; unreviewed generated output is not. The human
signing the commit is responsible for authorship rights, technical accuracy,
security, tests, citations, and every line retained.

Do not submit generated prose or code you cannot explain, bulk-open speculative
issues, fabricate test evidence, or use automation to imitate community support.
If a generative tool produced a substantial portion of the retained change,
briefly disclose that in the pull request and describe how you verified it. You
do not need to publish private prompts or unrelated proprietary context.

## Review and acceptance

Keep pull requests focused. The description must explain the outcome, affected
contracts, risk, verification commands and observable results, documentation
impact, and limitations. Complete the template and resolve review threads rather
than hiding disagreement in force-pushed history.

Reviewers evaluate, as applicable:

- correctness and runtime validation;
- authority, tenancy, credential, privacy, and effect boundaries;
- compatibility and migration cost;
- deterministic failure, replay, and crash behavior;
- package direction, portability, and public surface;
- dependency and release-chain risk;
- accessibility and English/Turkish parity; and
- whether claims are narrower than the evidence.

Passing automation is necessary but does not replace review. The merge rule,
material decision process, role ladder, conflicts, and founder-led limitation
are defined in [GOVERNANCE.md](GOVERNANCE.md).

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
