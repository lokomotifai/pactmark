# Portable agent

One unchanged agent implementation is called through Node, Vercel, and Cloudflare-shaped entrypoints. All three use the same deterministic fixture and return a normalized contract result.

```sh
pnpm --filter pactmark-example-portable-agent test
pnpm --filter pactmark-example-portable-agent typecheck
pnpm --filter pactmark-example-portable-agent build
pnpm --filter pactmark-example-portable-agent dev
```

No provider key or network access is required. These entrypoints are adapter-boundary fixtures, not deployed servers. Durable storage, sandboxing, and background wakeups are deliberately unsupported.
