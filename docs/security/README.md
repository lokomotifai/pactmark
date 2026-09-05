# Public security model

These version-controlled records are the self-contained security starting point
for Pactmark contributors and deployers. Access to a separate documentation
repository is not required to understand the trust boundaries or review a
security-sensitive change.

Read them in this order:

1. [Security model](./security-model.md) — assets, trust boundaries, invariants,
   deployment responsibilities, and non-claims.
2. [Threat model](./threat-model.md) — threats, mitigations, executable evidence,
   owners, and residual risk.
3. [Sandbox boundary](./sandbox-boundary.md) — what the reference container does
   and does not isolate.
4. [Supply chain](./supply-chain.md) — dependency, build, artifact, provenance,
   and publication controls.
5. [Vulnerability response](./vulnerability-response.md) and
   [incident playbook](./incident-playbook.md) — private reporting, triage,
   containment, evidence handling, and disclosure.

The short version is deliberately conservative: the model is never authority;
unknown input and metadata fail closed; tenant identity participates in every
storage path; credentials stay behind host-owned ports; append-only events are
run truth; uncertain external effects are not retried without a registered
safety proof; and production claims require executable deployment evidence.

Pactmark does not claim universal exactly-once effects, arbitrary-code sandbox
isolation, certification, or that installing the framework makes a host secure.
Identity, tenancy, secrets, network enforcement, retention, backup, monitoring,
provider terms, and incident response remain deployment responsibilities.
