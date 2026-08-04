---
title: Threat model
description: Review adversaries, controls, executable evidence, owners, and residual risk.
---

> Compatibility: Pactmark 0.1.x.

This model covers the portable kernel, adapters, local release path, and the tested
reference hosts. It does not replace an operator's deployment-specific assessment.
A green test applies only to its exact fixture and environment. Live provider,
platform, identity, network, database, and repository settings remain open until
inspected.

Severity uses `critical`, `high`, `medium`, and `low`. Every high or critical item
has an owner, executable or inspection evidence, and a residual-risk statement.

## Trust boundaries

1. unauthenticated input to authenticated host authority;
2. host work state to model export;
3. model output to tool request;
4. policy decision to credential and effect execution;
5. process memory to Postgres, artifact, and protected stores;
6. MCP discovery and transport to registered tool metadata;
7. workspace/sandbox to host filesystem and network;
8. source and dependencies to candidate tarballs and public release;
9. run data to logs, telemetry, evidence, and downstream consumers.

## High and critical register

| ID    | Severity | Threat and impact                                                                                                                          | Required controls                                                                                                                                                           | Evidence                                                                       | Owner and residual risk                                                                                              |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| TM-01 | critical | Direct prompt injection convinces a model to exceed purpose or request a forbidden tool.                                                   | Model has no authority; exact AgentDefinition and WorkOrder binding; default-deny policy and per-effect recheck.                                                            | Core identity, runtime command, and policy adversarial suites.                 | Runtime/policy maintainers. An allowed model action can still be undesirable inside an overly broad host grant.      |
| TM-02 | critical | Indirect injection in files, web content, MCP results, or tool output causes goal hijack or data export.                                   | Treat returned content as untrusted; bounded context admission; explicit purpose/data/egress profiles; no automatic grants.                                                 | Context/resource limits, malicious metadata, and egress denial fixtures.       | Host integrator. Semantic manipulation inside admitted data remains a model risk.                                    |
| TM-03 | critical | A poisoned or drifted tool changes behavior while retaining an old identity.                                                               | Tool schema, security metadata, factory/executor source, and implementation version contribute to registration digest; same-version drift fails.                            | Registration-source and same-version drift gates.                              | Tool owner. A malicious implementation can act within its declared and granted scope.                                |
| TM-04 | critical | Confused-deputy execution uses another principal's grant, tenant, purpose, decision, or credential.                                        | Authority binds tenant/principal/purpose; one-use reservations; every storage path and effect checks exact bindings.                                                        | Authorization reservation, cross-tenant, credential, and command-replay tests. | Identity/host owner. Incorrect upstream identity mapping remains external risk.                                      |
| TM-05 | critical | Approval replay, forgery, or weak-auth decision dispatches a high-risk effect.                                                             | Authenticated DecisionChallenge; keyed opaque proof; atomic consume with exact effect/grant/SecretRef bindings; expiry and role strength.                                   | Approval/challenge replay, cross-tenant, wrong-role, and zero-dispatch tests.  | Decision-system owner. Human misunderstanding of an accurate preview remains possible.                               |
| TM-06 | critical | Secret exfiltration exposes provider, tool, database, or decision credentials through model context or observability.                      | Opaque ModelCredentialRef/SecretRef; resolve only in bound adapter; sealed credential lifecycle; redaction canaries across all outputs.                                     | Credential-boundary, secret, telemetry, public-surface, and release audits.    | Credential/adapter owners. Compromised host process or provider endpoint can still access authorized values.         |
| TM-07 | critical | Cross-tenant storage access reads or mutates another tenant's run, context, artifact, approval, or effect.                                 | Tenant identifier in every store path/index; authority-scoped idempotency; non-disclosing not-found behavior.                                                               | Memory/Postgres contract suites and authenticated HTTP negative tests.         | Store/host owners. Database superusers and operator mistakes require infrastructure controls.                        |
| TM-08 | critical | An uncertain external effect is repeated after crash, timeout, or lost response.                                                           | Persist effect preparation/acknowledgement; exact registered effect strategy; park uncertainty; reconciliation or separate compensation authority.                          | Crash-boundary matrix and two-process acknowledged-effect proof.               | Tool/runtime owner. No global exactly-once claim; external system truth may remain unavailable.                      |
| TM-09 | high     | Scope or path traversal escapes an allowed workspace, tenant namespace, artifact prefix, or target.                                        | Canonical identifiers and paths; repeated decoding checks; physical symlink resolution; package-relative allowlists.                                                        | Property-based canonicalization and sandbox traversal/symlink probes.          | Policy/executor owners. Kernel or storage implementation flaws remain outside pure normalization evidence.           |
| TM-10 | high     | SSRF or redirect abuse reaches loopback, metadata, private, or credential-stealing origins.                                                | Normalized exact HTTPS origins; blocked address classes; DNS/redirect policy; injected egress broker; origin-bound credentials and limits.                                  | Policy canonicalization, HTTP/MCP egress, loopback/metadata denial fixtures.   | Egress/host owner. DNS rebinding and network-provider behavior need deployment controls.                             |
| TM-11 | high     | Model or tool cost exhaustion exceeds tenant/provider budgets.                                                                             | Pessimistic durable reservations for active time, calls, tokens, bytes, and cost; provider output cap; uncertain calls retain maximum charge.                               | Resource-profile, admission, concurrency, crash, and infinite-loop tests.      | Runtime/operator. Estimator and price inputs can be conservative, stale, or provider-dependent.                      |
| TM-12 | high     | Lease theft, stale worker commit, or concurrent duplicate command corrupts run state.                                                      | Database-time leases, fencing tokens, optimistic event sequence, atomic command UoW, request digest conflict.                                                               | Postgres concurrency, clock-skew, worker, and duplicate-command tests.         | Store/worker owners. Database outage and failover behavior depends on the deployed service.                          |
| TM-13 | critical | Sandbox escape or resource attack reaches host secrets, filesystem, socket, network, or availability.                                      | Reference fixture uses non-root, no network/mount/socket, read-only root, tmpfs, dropped capabilities, no-new-privileges, and hard resource bounds.                         | Container probes for secret/path/symlink/socket/network/fork/loop/output.      | Deployment owner. The fixture is explicitly not production arbitrary-code isolation.                                 |
| TM-14 | high     | Malicious MCP server metadata, schema drift, cursor loops, process output, or transport redirects poison registration or exhaust the host. | Pin server/transport identity and capabilities; treat discovery as unknown; exact tool metadata; bounded pages/process/output/time; cleanup.                                | MCP conformance, malformed discovery, stdio, HTTP, and cancellation suites.    | MCP/host owner. Production stdio requires a separately assessed SandboxAdapter.                                      |
| TM-15 | critical | Dependency, lifecycle script, workflow, or build compromise alters candidate bytes or steals release authority.                            | Exact lock; lifecycle deny-by-default; versioned allowlist; immutable actions; offline advisory/license/secret/workflow audits; no long-lived release token.                | Lifecycle canary and supply-chain audit gates.                                 | Dependency/release owners. Time-bound advisories and upstream compromise require live refresh and incident response. |
| TM-16 | critical | Package confusion, workspace-link leakage, wrong registry/access, or tarball substitution publishes unintended code.                       | Exact scope/version/internal deps; allowlisted staged packer; two byte-identical archives; frozen independent consumers; guarded publisher and anonymous-byte verification. | Pack, NodeNext/Bundler/Yarn/Bun, loopback registry, and release-command tests. | Release owner. Public writes are still unperformed; namespace race remains until ownership exists.                   |
| TM-17 | high     | Logs, telemetry, evidence, artifacts, or errors leak raw inputs, protected context, secrets, or challenge proofs.                          | Separate output schemas; metadata-only telemetry; explicit redaction; content absent by default; stable non-disclosing errors.                                              | Redaction, secret-canary, telemetry, evidence, HTTP, and audit tests.          | Observability/evidence owners. Consumer-added exporters must preserve classification and retention.                  |
| TM-18 | high     | Verification or evidence is misrepresented as truth, certification, compliance, or universal security.                                     | Exact artifact/verifier/rubric bindings; bounded claim language; exception types cannot waive security; readiness separates local/external evidence.                        | Evidence/verifier suites, placeholder/public-doc checks, and readiness review. | Maintainers and downstream user. Human marketing or governance misuse cannot be prevented solely in code.            |

## Additional medium risks

- cancellation or deadline is ignored by a third-party adapter;
- backup, retention, deletion, or key rotation is incomplete across replicas;
- a supported provider changes semantics without a versioned adapter update;
- denial messages become an enumeration oracle;
- performance degradation causes queue growth inside configured but overly generous bounds;
- a maintainer account or external organization setting is compromised.

These require bounded adapter contracts, deployment monitoring, access review,
backup/restore drills, live advisory checks, protected release environments, and
incident response. They do not justify weakening a high/critical control.

## Review triggers

Review this model for any new public package, persistence or protocol adapter,
credential path, effect strategy, sandbox, hosted service, release mechanism,
supported platform, data class, or externally verified deployment. Record accepted
changes in an ADR and PLAN.md Decision Log when architecture changes.
