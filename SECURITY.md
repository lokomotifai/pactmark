# Pactmark security policy

Pactmark treats model output, tool output, external input, and persisted data as
untrusted. We welcome good-faith reports that help protect users and the
project's release chain.

## Supported versions

Security fixes are made on the latest patch of the current `0.2.x` line and on
`main`. Pre-1.0 support is intentionally narrow: users should upgrade to the
latest patch before reporting an already-fixed issue.

| Version           | Security fixes                                  |
| ----------------- | ----------------------------------------------- |
| `0.2.0`           | Supported                                       |
| `0.1.2` and older | Not supported                                   |
| `main`            | Receives fixes; not a released support contract |

This table is a maintenance commitment, not a certification or a statement
that a version is free of vulnerabilities.

## Report privately

Use [GitHub Private Vulnerability Reporting](https://github.com/lokomotifai/pactmark/security/advisories/new).
It is enabled for this repository and lets maintainers discuss, patch, and
coordinate disclosure without exposing the report in a public issue.

If that route is unavailable, email
[fatih@komunite.com.tr](mailto:fatih@komunite.com.tr?subject=Pactmark%20security%20contact)
only to establish an alternate private channel. Do not place exploit details or
secrets in unencrypted email. Do not open a public issue to ask whether a report
is valid.

Include what you can safely provide:

- affected package, version, commit, adapter, and deployment profile;
- impact and the authority, tenant, credential, or data boundary crossed;
- minimal reproduction with synthetic data;
- relevant event types, stable error codes, and redacted digests;
- whether exploitation is known or suspected in the wild; and
- your preferred contact and disclosure expectations.

Never send live credentials, personal data, customer content, proprietary
prompts, or more accessed data than is necessary to establish impact.

## In scope

Reports may cover source code, npm packages, release automation and provenance,
authority bypass, cross-tenant access, unsafe effect replay, credential or
secret exposure, prompt/tool injection that crosses a policy boundary,
artifact or evidence integrity, or a material gap between a documented security
claim and executable behavior.

An application built with Pactmark also depends on its host identity, policy,
grants, tools, model provider, egress, storage, and deployment. Please identify
whether the suspected defect is in Pactmark or host wiring when possible. Do not
test systems or data you do not own or have explicit permission to test.

## Response and disclosure

These are targets, not contractual service levels:

- acknowledgement within three business days;
- initial triage within seven business days; and
- a proposed remediation or coordination plan for a confirmed high-impact
  report within fourteen business days.

Maintainers will minimize access to the report, validate with synthetic data,
prepare regression tests, and coordinate disclosure with the reporter. Public
disclosure normally follows an available mitigation and reasonable upgrade
window. Active exploitation or broad public knowledge may require an accelerated
advisory. Confirmed release vulnerabilities may receive a GitHub Security
Advisory and, when appropriate, a CVE; neither is automatic.

## Safe harbor

The project will not initiate legal action against good-faith research that:

- follows this policy and applicable law;
- tests only systems and data the researcher owns or is authorized to test;
- avoids privacy violations, persistence, social engineering, service
  disruption, and data destruction;
- accesses the minimum data needed to demonstrate the issue and deletes it
  promptly; and
- allows a reasonable opportunity to remediate before public disclosure.

This statement cannot authorize testing of third-party services or waive the
rights of others. Ask for written authorization before testing if the boundary
is uncertain.

## Security model limitations

Default-deny policy, runtime schemas, capability grants, human decisions,
budgets, effect records, and verification reduce specific risks; they do not
make an agent or host inherently secure. The trusted in-process executor is not
an arbitrary-code sandbox. Declared egress is not network isolation unless the
host enforces it. Pactmark does not claim universal exactly-once effects,
production isolation, or certification. Deployers remain responsible for
identity, tenancy, secrets, least privilege, network policy, retention, backup,
provider terms, monitoring, and incident response.

The detailed boundaries are documented in the
[security model](https://pactmark-docs.lokomotif.ai/security/security-model)
and [threat model](https://pactmark-docs.lokomotif.ai/security/threat-model).
