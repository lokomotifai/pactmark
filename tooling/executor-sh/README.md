# Executor self-host conformance

This gate exercises the exact Executor `v1.5.40` platform manifest used by the current host. It
does not pull implicitly. Bootstrap the digest-pinned image separately:

```sh
pnpm bootstrap:executor-sh-image
pnpm test:executor-sh-container
```

The gate starts two tenant instances and one backup-restore instance on a temporary internal Docker
network. The main processes run as UID/GID 65532 with a read-only root filesystem, a dedicated data
volume, dropped capabilities, `no-new-privileges`, and hard resource limits. It verifies health,
bootstrap, restart persistence, stopped-volume backup/restore, telemetry opt-out and analytics-id
absence, denied outbound/private network access, disabled stdio MCP, unauthenticated denial, API-key
MCP, PKCE OAuth, cross-instance credential denial, the `execute` result envelope, secret-safe logs,
and exact-target cleanup.

The resulting receipt is valid for at most seven days and is digest-bound to the host/platform
observation. It is deployment evidence, not a signature or a general container-escape claim.

The public read-only matrix is a separate, explicitly network-authorized gate. It creates an
ephemeral, hardened instance with public egress, registers six GET-only NPM download operations,
discovers and invokes all six through MCP `execute`, validates the response shapes/statuses, scans
logs for credential canaries, and removes the exact container and data directory:

```sh
pnpm test:executor-sh-read-tools:live
```

This live gate does not run inside `pnpm verify`, does not use a SaaS credential, and does not make
external writes. Production deployments still need an infrastructure-owned egress allowlist.

The private adapter package also has an independent tarball-consumer gate:

```sh
pnpm test:executor-sh-packed
```

It packs `@pactmark/executor-sh`, `@pactmark/core`, and `@pactmark/mcp`, installs only their `.tgz`
artifacts into a temporary offline consumer, rejects workspace links and private/source files, and
runs the deployment receipt/profile API on the current Node.js host. CI runs the canonical gate on
both supported Node.js release lines.
