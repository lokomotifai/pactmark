# Security policy

Pactmark treats model output, tool output, external input, and persisted data as
untrusted. Security reports are welcome and should be handled privately.

## Supported versions

Pactmark has not made a public release. The current development branch receives
security fixes on a best-effort basis but is not a supported production
release. After release, this table will identify supported version lines rather
than implying support from package metadata alone.

| Version                       | Supported                                                       |
| ----------------------------- | --------------------------------------------------------------- |
| Unreleased development source | Best-effort security fixes; not a production support commitment |
| Public releases               | None published or verified                                      |

## Scope

Reports may cover Pactmark source, published artifacts once they exist, release
automation, dependency or build-chain risk, authority bypass, tenant isolation,
unsafe effect replay, secret exposure, prompt/tool injection crossing a policy
boundary, evidence integrity, or a discrepancy between a documented security
claim and actual behavior.

Vulnerabilities in an application built with Pactmark may depend on that
application's model, tools, identity, grants, egress, deployment, and data
handling. Please identify whether the issue is in Pactmark or host wiring when
possible. Do not test systems or data you do not own or have permission to
test.

## Private reporting

GitHub Private Vulnerability Reporting is the intended primary route after a
public repository exists, but it is **not verified as enabled**. No dedicated
security mailbox or public repository URL has been verified from this checkout.

For now, contact the repository owner through the same private channel by which
you received access. If you do not have such a channel, retain the report and
avoid filing exploit details in a public issue until this document publishes a
verified private route. This is an explicit bootstrap limitation, not a claim
that a private reporting service is available.

Include, when available:

- affected version, commit, package, adapter, and deployment profile;
- impact and the authority or data boundary crossed;
- minimal reproduction and prerequisites;
- sanitized logs, event types, or artifact/evidence digests;
- whether exploitation is known or suspected in the wild;
- suggested mitigations; and
- your preferred contact and disclosure expectations.

Never send live credentials, personal data, customer content, model prompts, or
other secrets. Use synthetic fixtures and redact tokens and identifiers.

## What to expect

The following are non-contractual goals, measured from receipt through a
verified private route:

- acknowledge within 3 business days;
- complete initial triage within 7 business days;
- communicate a mitigation plan for a confirmed high-impact issue within 14
  business days; and
- coordinate release and disclosure based on impact, exploitability, and
  affected-user needs.

Bootstrap staffing, incomplete reports, and cross-project coordination may
change these timelines. The reporter will be told when that happens where a
working contact route exists.

## Coordinated disclosure

Maintainers will validate the report, minimize access to sensitive details,
prepare tests and fixes, and coordinate a disclosure date with the reporter.
Public disclosure should normally follow availability of a mitigation and give
affected users reasonable time to update. Active exploitation or broad public
knowledge may require an accelerated advisory.

When the public repository supports it, confirmed vulnerabilities may receive
a GitHub Security Advisory. Maintainers may request a CVE for a vulnerability
with meaningful user impact and an identifiable affected release. A GHSA or CVE
is not guaranteed and will not be created for an unreleased or non-security
bug merely to assign an identifier.

## Safe harbor

The project will not initiate legal action against good-faith research that:

- follows this policy and applicable law;
- tests only systems and data the researcher owns or is authorized to test;
- avoids privacy violations, service disruption, persistence, social
  engineering, and data destruction;
- accesses only the minimum data needed to demonstrate the issue and promptly
  deletes it; and
- allows a reasonable opportunity to remediate before disclosure.

This statement cannot authorize testing of third-party services or waive the
rights of others. If uncertain whether planned research fits this policy, seek
written authorization before proceeding.

## Security model limitations

Default-deny policy, schemas, grants, approvals, budgets, effect records, and
verification reduce risk; they do not make an agent or its host inherently
secure. The trusted in-process executor is not an arbitrary-code sandbox.
Declared egress controls are not network isolation unless the selected host
actually enforces them. Deployers remain responsible for identity, tenancy,
secrets, least privilege, network policy, retention, backups, and incident
response.
