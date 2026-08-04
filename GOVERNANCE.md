# Project governance

Pactmark uses maintainer stewardship with public, evidence-backed decisions.
The project is currently in private bootstrap: no public remote, branch
protection, repository roles, or release authority has been verified.

## Roles

**Contributors** submit issues, documentation, code, tests, or review. A merged
contribution does not automatically grant project authority.

**Maintainers** review and merge changes, steward releases, enforce project
policy, and manage security reports. Current membership and verification state
are recorded in [MAINTAINERS.md](MAINTAINERS.md).

**Repository owner** controls repository-level access and appoints or removes
maintainers. The current owner's account identity is not yet verified in this
local repository.

## Decisions

Routine, reversible decisions are made through pull-request review. Maintainers
seek rough consensus, with the responsible maintainer making a documented
decision when consensus is unavailable.

Material decisions require a public RFC or Architecture Decision Record before
implementation. This includes changes to:

- product thesis or supported/excluded scope;
- public wire formats and compatibility promises;
- package boundaries and dependency direction;
- authority, policy, privacy, evidence, or effect-safety invariants;
- supported runtimes and toolchain baseline;
- governance, licensing, trademark, security, or release policy.

An ADR records context, decision, consequences, and status. Accepted ADRs are
immutable historical records: supersede one with a new ADR rather than silently
rewriting the decision. Urgent security mitigation may precede public detail,
but the non-sensitive decision record must follow after disclosure risk passes.

## Reviews and merges

Every change requires relevant tests and at least one maintainer review. An
author must not be the sole approver of a material change. Security-critical,
release, dependency-policy, governance, and architectural changes require the
applicable verified owner review once CODEOWNERS is activated.

All commits require DCO sign-off. Passing automation supports but does not
replace human review. External branch protection and required checks remain
unverified until a real public remote is configured and inspected.

## Releases

Pactmark follows Semantic Versioning and Changesets. Releases must use the
guarded, evidence-producing release process; maintainers may not publish from a
workspace directory or bypass required verification. A release requires
explicit external authorization, exact artifact verification, and recorded
provenance inputs. No public release exists at this baseline.

## Maintainer changes and conflicts

The repository owner appoints maintainers based on sustained, constructive
contributions and demonstrated judgment in the relevant area. The reason and
effective date are recorded in `MAINTAINERS.md`. Removal may follow inactivity,
resignation, policy violation, security risk, or loss of project access; the
non-sensitive reason is documented.

Reviewers disclose material conflicts and recuse themselves. A maintainer may
appeal a decision to the repository owner. If the owner is conflicted, an
unconflicted maintainer should document the decision; until more than one
verified maintainer exists, the project must defer non-urgent conflicted
decisions.

## Changes to governance

Governance changes use the same public proposal and review process and must not
retroactively erase decision history.
