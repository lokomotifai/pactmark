# `@pactmark/policy`

Portable, deterministic policy primitives for Pactmark. The package denies by
default and contains no model, provider, platform, filesystem, network, or
environment integration.

The public slice includes:

- risk gates for `R0` through `R5`;
- exact purpose, data-class, scope, budget, grant, preview, approval, and
  network-capability checks;
- canonical identifier, tenant, resource-path, host, URL, and tool-argument
  handling;
- an opaque-authority `GrantIssuer` and deterministic in-memory grant contract
  implementation for local/test composition;
- executable EffectStrategy/PreviewStrategy registration validation, including
  same-domain transactional proof and separate compensation-tool binding;
- deterministic preview execution against a capability-minimal context;
- process-local reference stores for atomic-shaped AuthorizationReservation
  claims and finite admission leases;
- an opaque, one-use, revocation-checked SecretRef issuer/store/resolver
  boundary for local tests; and
- a versioned registration kill-switch registry.

`createPolicyEngine` is a preliminary implementation of the core port. Its
`allow_with_grant` result is never executable authority. The runtime must still
resolve the fully bound grant and atomically reserve its use. Use
`evaluatePolicy` at that full-authorization boundary.

Path canonicalization is portable and rejects traversal, encoded traversal,
absolute paths, and backslash ambiguity. Symlink resolution remains a host
filesystem responsibility; after resolving without following an unsafe path,
the host can pass its logical root and resolved relative path to
`assertNoSymlinkEscape`.

URL checks reject identifiable private, reserved, loopback, link-local, and
metadata literals. This is policy validation, not DNS pinning or network
isolation. Only a host executor that enforces and tests those controls may claim
`networkPolicy: "enforced"`.

The memory grant, authorization, secret, and admission implementations are
process-local references. They deliberately do not advertise durability or
cross-process atomicity. A durable host must implement the corresponding core
ports in one transaction domain with the command/effect/event writes. Strategy
registration verifies the executable shape and declared identity; runtime must
still provide the restricted strategy-specific execution context, validate
results and acknowledgements, and drive crash recovery/reconciliation.

## Local verification

```sh
pnpm --filter @pactmark/policy typecheck
pnpm --filter @pactmark/policy test
pnpm --filter @pactmark/policy build
```

## Release state

Version `0.1.1` is public on npm with verified registry bytes and provenance. The
process-local implementations above remain development references, not production
durability or isolation.
