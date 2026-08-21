# Pactmark governance

Pactmark is an open-source project stewarded in public. Governance exists to
make authority legible: who may decide, what evidence a decision needs, how a
contributor earns trust, and how the project can outlive any one person.

The project is currently **founder-led**. That is a description of its present
capacity, not a permanent entitlement or a claim of community consensus. The
current people and scopes are recorded in [MAINTAINERS.md](MAINTAINERS.md).

## Governing principles

1. **Authority is explicit.** Repository, release, security, and moderation
   authority is granted by role and scope; a title alone grants nothing.
2. **Decisions leave a record.** Material decisions state the problem,
   alternatives, trade-offs, and the person accountable for the outcome.
3. **Trust follows demonstrated stewardship.** Code, documentation, review,
   issue triage, security work, and community care all count as contribution.
4. **Security claims require evidence.** A green check, document, or role does
   not by itself prove a runtime, deployment, or supply-chain property.
5. **The project can grow without pretending it already has.** Committees and
   voting bodies are created only when named people accept those duties.

## Roles

Roles are additive and may be scoped to packages, documentation, releases,
security, or community moderation.

### Contributor

Anyone who improves Pactmark through an issue, review, test, design note,
documentation change, code change, translation, or community support is a
contributor. No merged pull request or organization membership is required for
the label.

Contributors may propose work and participate in every public decision. They do
not merge changes, publish releases, access private reports, or speak for the
project unless a maintainer explicitly delegates that task.

### Reviewer

A reviewer has demonstrated reliable judgment in a named scope. Reviewers may
triage issues and provide reviews that maintainers use for acceptance, but do
not receive merge or release authority by default.

A reviewer candidate should have a sustained contribution history, understand
the relevant contracts and limitations, review other people's work
constructively, and respond well when evidence changes their position. There is
no contribution counter that automatically confers the role.

### Maintainer

A maintainer is accountable for a documented scope and may approve and merge
changes in that scope. Maintainers are expected to:

- protect compatibility, security invariants, and honest product claims;
- review work from others, not only advance their own work;
- explain consequential decisions and disclose material conflicts;
- keep issues and reviews moving or clearly hand them off;
- use two-factor authentication and follow repository security controls; and
- mentor contributors toward greater responsibility.

Repository administration, npm publication, release approval, private
vulnerability access, and conduct response are separate capabilities. They are
listed explicitly in [MAINTAINERS.md](MAINTAINERS.md) and are never implied by
generic maintainer status.

### Emeritus maintainer

An emeritus maintainer is recognized for past stewardship but holds no current
project authority. Returning to an active role uses the normal appointment
process so that access reflects current context and availability.

## Contributor ladder

Role changes are proposed by pull request to `MAINTAINERS.md`. The proposal must
identify the scope, summarize the candidate's relevant work, describe the
authority requested, and record the candidate's consent.

During the founder-led stage, the repository owner appoints reviewers and
maintainers and publishes the rationale. Once two or more active maintainers
exist, an appointment requires support from two active maintainers, no
unresolved substantiated objection, and at least seven calendar days for public
comment. A candidate never approves their own appointment.

Roles are reviewed when their holder has been inactive for six months, can no
longer meet the role's security requirements, asks to step down, or repeatedly
fails the responsibilities above. Removal follows notice and a chance to
respond, except when immediate access revocation is necessary to contain a
security or safety risk. The non-sensitive outcome is recorded publicly.

## Decision process

The process is proportional to impact:

| Decision class        | Examples                                                                                                                                              | Process                                                                                   | Final authority                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| Routine               | Bug fixes, tests, editorial docs, internal refactors                                                                                                  | Pull request and relevant checks                                                          | Maintainer for the affected scope       |
| Material              | Public API or schema, package boundary, new adapter contract, compatibility promise, contribution agreement, licensing, governance, or release policy | Public proposal, alternatives, impact analysis, comment period, then an ADR when accepted | Maintainers for the affected scopes     |
| Sensitive             | Vulnerability response, credential or release compromise, active abuse                                                                                | Private coordination until disclosure is safe; public record afterward                    | Assigned security or conduct responders |
| Reversible operations | Labels, issue triage, routine automation maintenance                                                                                                  | Public issue or pull request when useful                                                  | Delegated reviewer or maintainer        |

A material proposal should use the feature-proposal issue form before code is
written. It must cover motivation, non-goals, compatibility, authority and data
boundaries, rollout or migration, alternatives, and executable evidence.
Maintainers normally leave material proposals open for at least seven calendar
days after the design is stable. They may extend that period to involve affected
contributors.

Pactmark seeks informed consent, not unanimity. Maintainers surface objections,
attempt to resolve them, and then publish a reasoned accept, revise, defer, or
reject decision. Silence is not counted as endorsement. Accepted architectural
decisions live in `docs/adr/`; a later decision supersedes an ADR instead of
rewriting history.

### Founder-led merge rule

While Pactmark has one active maintainer, independent maintainer approval is
not possible and the repository does not claim it. A sole maintainer may merge
their own pull request only after required checks pass and unresolved review
threads are addressed. Material self-authored changes should remain open for a
public review window unless delaying them would increase a documented security
or operational risk.

When a second active maintainer is appointed, material changes require approval
from an unconflicted maintainer other than the author. Repository protection
must be tightened to enforce that rule before the new role is treated as active.

## Conflicts of interest

A decision-maker discloses relationships that a reasonable contributor could
see as affecting their judgment, including employment, investment, paid work,
close personal relationships, or competing project leadership. Disclosure need
not reveal confidential terms.

An affected person does not cast the deciding review on their own appointment,
removal, conduct case, financial arrangement, or material vendor selection. If
every current maintainer is conflicted, the project defers a non-urgent decision
and seeks an independent reviewer. Security containment may proceed with the
minimum necessary action and a later public accountability record.

## Releases and project assets

### Contribution terms and licensing

Every commit remains subject to DCO 1.1 sign-off. The proposed Contributor
License Agreement is additive, remains pending legal review, and has no effect
until its placeholders are filled and the project announces
`<EFFECTIVE_DATE>`. If adopted, it covers only Contributions merged on or after
that date and does not retroactively alter earlier contributions.

Pactmark remains Apache-2.0 licensed. A CLA preserves a future option; it does
not itself authorize or announce a relicensing. Adopting the CLA, changing the
project license, dual-licensing, or using CLA-granted rights for a different
licensing model is a material decision subject to the public process above.

Pactmark follows Semantic Versioning and uses Changesets. A release must come
from the guarded repository workflow, pass the declared gates, and preserve its
artifact and provenance evidence. npm ownership, GitHub administration, domain
control, signing material, and deployment access are project-critical assets;
access is least-privilege and recorded in maintainer scope.

Project funds or material sponsorships, if introduced, will be disclosed with
the decision rights they do and do not purchase. Financial support never buys a
merge, security finding, roadmap commitment, or governance role.

## Continuity

Maintainers should avoid single-person operational knowledge by documenting
release, security, and recovery procedures. Before stepping down, a holder of a
project-critical capability should transfer it to another active maintainer or
publish the exact limitation if no successor exists.

If the project becomes unmaintained, the last active maintainer should mark the
repository and packages accordingly rather than imply ongoing support. The
Apache-2.0 license preserves the community's right to fork; project names and
logos remain subject to [TRADEMARKS.md](TRADEMARKS.md).

## Amending this document

Governance changes are material decisions. They use a public pull request, state
the problem being solved, and receive the comment period and approvals described
above. Changes do not retroactively erase role or decision history.
