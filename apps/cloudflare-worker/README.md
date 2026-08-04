# Pactmark experimental Cloudflare Worker fixture

This module Worker uses Web APIs and the portable Pactmark subset. It does not enable `nodejs_compat`, durable storage, a filesystem, a sandbox, background wakeups, or isolated egress. The compatibility date is fixed at `2026-08-03`; update it only with dependency review plus typecheck, contract test, and dry-run evidence.

```sh
pnpm --filter cloudflare-worker typecheck
pnpm --filter cloudflare-worker test
pnpm --filter cloudflare-worker types:check
pnpm --filter cloudflare-worker deploy:dry-run
```

`deploy:dry-run` performs a local bundle/config validation and is not a deployment. `deploy:live` is deliberately excluded from aggregate verification and requires separate external authorization.
