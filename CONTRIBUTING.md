# Contributing to Pactmark

Thank you for helping improve Pactmark. Contributions are reviewed for
correctness, security, portability, and honest product claims—not only for a
passing build.

## Before you start

- Use an issue for bugs and focused changes.
- Use a public RFC or ADR proposal before changing package boundaries, wire
  formats, security invariants, release policy, or other accepted decisions.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
  not in a public issue.
- Never commit credentials, customer data, production data, or private design
  inputs.

The repository currently has no verified public remote or external repository
settings. Any hosted issue, discussion, or private-reporting route described by
the templates becomes available only after that remote and its settings are
created and inspected.

## Development setup

Requirements:

- Node.js 24 for development; the supported CI matrix also covers Node.js 22.
- Corepack and the exact pnpm version declared by the root `package.json`.
- Git.

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The lockfile and lifecycle-script allowlist are security controls. Do not
approve a new install script without recording its package, owner, reason, and
review. Tests must not require live model, platform, registry, database, or
other SaaS credentials. Use deterministic fakes and local fixtures.

Before requesting review, run:

```sh
pnpm verify
```

During early bootstrap, individual scripts may be introduced by the owning
work package. A contribution is ready only when every relevant root command is
material and passes; an absent or placeholder command is not a successful
check.

## Change requirements

- Keep public code, API names, errors, and canonical documentation in English.
- Add or update Turkish companion documentation where the documentation policy
  requires semantic parity.
- Validate untrusted inputs at runtime and avoid public `any`.
- Preserve provider- and platform-neutral package boundaries.
- Add tests that demonstrate behavior, including failure and replay behavior
  where relevant.
- Update documentation and examples when a public contract changes.
- Add a Changeset for a user-visible change after the initial release baseline.
- Do not edit generated output directly when a reproducible source exists.

## Developer Certificate of Origin

Pactmark uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Every commit must include a sign-off certifying that you have the right to
submit the contribution under the project's license:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Create it with:

```sh
git commit -s
```

Use your real or otherwise legally attributable contribution identity and an
email address you are authorized to use. A pull-request checkbox does not
replace per-commit sign-off. Fix missing sign-offs by amending or rebasing your
own commits; do not rewrite another contributor's certification.

## Pull requests and review

Keep pull requests focused and explain the user-visible outcome, risk, tests,
and limitations. Complete the pull-request template. At least one maintainer
review is required; security-critical, release, governance, and architecture
changes require review by the applicable verified owner once CODEOWNERS is
activated.

Automated checks and branch protection are not yet verified on a public remote.
Their absence does not waive review, DCO, test, or security requirements.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
