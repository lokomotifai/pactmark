# Security incident playbook

This playbook applies to suspected malicious tool/MCP/model/policy registrations, leaked credentials, tenant crossover, altered release bytes, and unsafe effects. It does not imply that a private vulnerability channel, branch rule, trusted publisher, or public advisory setting has been configured; those require inspection of the authorized external system.

## Immediate safety actions

1. Name an incident coordinator and UTC start time. Preserve append-only events, command/effect records, release manifest, registry responses, and relevant metadata logs without copying secret values or hidden model reasoning.
2. Stop new affected work. Revoke the exact tool, model adapter, MCP server/tool, policy, verifier, or agent-definition digest through the kill switch. A running agent must query revocation again before its next high-risk reservation or dispatch; cached admission is not authority.
3. Identify affected tenants, runs, WorkOrder bindings, effects, artifacts/evidence, package versions, and release manifests by exact digest/version. Do not enumerate one tenant through another tenant's access path.
4. Mark uncertain effects for reconciliation. Never retry an uncertain external write merely because the worker/request failed.
5. Rotate the smallest affected credential set at its provider, revoke sessions/refs, and verify that old refs resolve zero times. Do not paste the leaked value into issues, logs, tests, or evidence.
6. Denylist the malicious digest/version in runtime and release admission. If release bytes may be compromised, stop publication and mark the candidate manifest `abandoned`; preserve it for investigation.

## Containment through recovery

7. Publish a bounded mitigation through an authorized channel: affected versions/digests, safe configuration, observed impact, and what remains unknown. Avoid speculative attribution.
8. When available and authorized, prepare the fix in a private advisory fork. Otherwise minimize public disclosure until a fix exists while preserving contributor safety and coordinated-disclosure commitments.
9. Add an adversarial regression reproducing the exact binding/failure. It must prove zero unauthorized effect or zero secret disclosure, not merely a thrown error.
10. Build the coordinated patch version once; regenerate checksums, CycloneDX SBOM, manifest, packed tests, and provenance inputs. Never reuse abandoned bytes/version after external exposure.
11. Notify affected users and maintainers; request or update GHSA/CVE only through the authorized disclosure process. An initial interactive npm bootstrap without provenance must say so explicitly and rely on attested-byte comparison.
12. Verify recovery: old digest denied, old credential unusable, next high-risk action re-checks revocation, fixed bytes match the new manifest, clean install/smoke passes, and no canary value appears in persisted/output surfaces.
13. Update the threat-model row, permanent preventive/detective controls, owner, residual risk, and drill evidence. Record what external controls were actually inspected.

## Release-specific uncertain writes

After any registry timeout, inspect anonymous exact-version state before another operation. If absent, a maintainer may authorize a new attempt; if present, bytes and public visibility must exactly match the frozen manifest before continuing. Mismatched or non-public state stops initializer publication and triggers incident review. The guarded publisher never performs an automatic retry or dist-tag repair.

## Evidence checklist

Retain UTC timeline, coordinator, input digests, affected scope, zero-effect/zero-resolution counters, kill-switch change, rotation confirmation (without secret), exact commands and exit status, regression ID, manifest/SBOM/checksum digests, user notification decision, residual risk, and external operations still pending.
