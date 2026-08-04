# DRILL-MCP-01 — malicious MCP/tool digest

- Date: 2026-08-03 UTC
- Type: bounded tabletop plus existing deterministic adapter tests
- Scenario: an allowed MCP identity changes its discovered tool schema/security digest, then its prior authority is revoked before a high-risk dispatch.
- Expected safety result: changed pin cannot be exposed; revoked/changed authority is re-checked immediately before dispatch; transport dispatch count remains zero.

Procedure:

1. Treat the original transport/server/tool-pin digests as the incident indicators and enumerate only bound runs.
2. Apply the kill-switch entry for the exact MCP/tool digest and invalidate scheduled work using it.
3. Exercise the adapter pin verification and immediate authority assertion in `packages/mcp/tests/adapter.test.ts` and `packages/mcp/tests/contracts.test.ts`.
4. Confirm that no model-selected transport, executable, endpoint, environment, or credential is accepted and that the mismatch fails before transport dispatch.
5. Follow the patch/SBOM/manifest and notification steps in the incident playbook.

Observable local evidence is the MCP package’s deterministic tests for exact tool pins, duplicate-digest conflict, cross-tenant binding, and revoked/changed authority. This drill does not claim a live MCP server, public advisory, deployed kill switch, or external notification was exercised.

Residual risk: a correctly pinned and explicitly granted server may still return malicious content within its granted scope. Content must remain untrusted and high-risk actions require a fresh policy/authority check.
