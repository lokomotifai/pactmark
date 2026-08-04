# DRILL-SECRET-01 — leaked tool credential

- Date: 2026-08-03 UTC
- Type: bounded tabletop plus deterministic credential/canary tests
- Scenario: a tool credential value is suspected exposed while opaque refs for queued work still exist.
- Expected safety result: provider credential is rotated/revoked; old refs resolve zero times; refs cannot cross tool/model/MCP port or tenant/purpose/destination binding; the registered canary value appears in none of model context, state, logs, traces, artifacts, evidence, or package output.

Procedure:

1. Record only the credential slot/ref and binding digests, never the value.
2. Disable affected registrations and pending high-risk work through the kill switch.
3. Rotate/revoke at the provider, expire related refs/reservations, and require the running agent to re-check revocation before its next high-risk action.
4. Exercise credential-binding, MCP credential, telemetry metadata-only, public-surface, secret-audit, and registered-canary tests.
5. Search only approved local test/output surfaces for the canary; a zero match is evidence for registered fields, not proof that arbitrary free text never contains a secret.
6. Add the exact leak path as a regression before coordinated patch/SBOM/manifest generation.

This drill did not rotate a real credential, contact a provider, or send an external notification. Those actions require an actual incident and explicit authority. The local exercise demonstrates the decision sequence and deterministic boundaries only.

Residual risk: unknown credentials embedded in arbitrary unclassified prose cannot be detected perfectly. Host classification, provider-side rotation, short-lived credentials, and least privilege remain necessary.
