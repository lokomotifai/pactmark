# Pactmark naming-freeze decision

Status: `KAF_NAMING_FREEZE_APPROVED`  
Approved at: `2026-08-04T06:22:03Z`  
Approver: repository owner, recorded through the Pactmark Codex task

## Frozen names

| Surface                         | Approved exact value                                  |
| ------------------------------- | ----------------------------------------------------- |
| Project display name            | `Pactmark`                                            |
| npm organization/scope          | organization `pactmark`; scope `@pactmark`            |
| Scoped public packages          | `@pactmark/*`                                         |
| Unscoped initializer            | `create-pactmark`                                     |
| Initializer command             | `npm create pactmark@latest`                          |
| CLI binary                      | `pactmark`                                            |
| GitHub organization             | `lokomotifai`                                         |
| GitHub repository               | `pactmark`                                            |
| Canonical repository coordinate | `lokomotifai/pactmark`                                |
| Trademark posture               | The cautious, unregistered posture in `TRADEMARKS.md` |

No `@pactmark/pactmark` package is part of v0.1. The main framework facade remains
`@pactmark/agent`; an unscoped `pactmark` installation package was discussed but was
not selected by this decision.

## Evidence and limits

The read-only evidence in `docs/releases/naming-readiness.md` found no exact npm or
GitHub collision on 2026-08-03. That evidence is time-sensitive and anonymous. It
does not prove that the npm organization, GitHub organization, repository, or any
package is currently available, reserved, or controlled by the approver.

This decision authorizes the local naming freeze, repository-wide conformance work,
and WP-09 documentation. It does **not** authorize Codex to create a GitHub or npm
organization, create a remote repository, reserve a name, push, publish, deploy,
configure external settings, or claim trademark clearance. The repository owner
stated that they will create the GitHub organization. Every external write still
requires explicit authorization and an evidence-backed release sequence.

No trademark registration or legal clearance search has been performed. The project
must not describe Pactmark as registered, exclusively controlled, certified, or
officially published until corresponding evidence exists.

## GitHub authority amendment

At `2026-08-04T07:56:00Z`, after explicit user direction to connect GitHub and
continue the external checklist in order, authenticated inspection verified
`fatihguner` as an active admin of `pactmark`. The empty public repository
`pactmark/pactmark` was created and bound to the local `origin`. ChatGPT Codex
Connector installation `151134458` was installed and then restricted from all
current/future repositories to the single `pactmark/pactmark` repository.

This amendment establishes repository authority and exact package repository
metadata. It does not authorize or claim a source push, tag, release, npm ownership,
package publication, deployment, trademark clearance, or production verification.

## Source-publication amendment

At `2026-08-04T08:15:17Z`, the owner explicitly authorized the first public source
commit and `main` push. Root commit
`3234ae5e0d5e7855d67aa3010cd2a12f88e86d3d` published the reviewed 733-file source
set to `pactmark/pactmark`. This amendment authorizes and records that source-control
write only; it does not authorize a tag, GitHub Release, npm scope/package write,
deployment, trademark-clearance claim, or production-readiness claim.
