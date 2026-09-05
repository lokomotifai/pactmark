# Portable agent

One unchanged agent definition executes through Pactmark's real local runtime.
The Node application function, Vercel-compatible `POST`, and Cloudflare
Worker-compatible `fetch` entrypoints normalize their transport boundary to the
same result. The result's event names and sequence come from the runtime; they
are not a hand-authored simulation.

```sh
pnpm --filter pactmark-example-portable-agent test
pnpm --filter pactmark-example-portable-agent typecheck
pnpm --filter pactmark-example-portable-agent build
pnpm --filter pactmark-example-portable-agent dev
```

No provider key or network access is required. The Web entrypoints have real
platform-compatible signatures, but this example does not add authentication,
tenant routing, deployment configuration, or a server listener. It is not a
deployed service. Durable storage, sandboxing, and background wakeups are
deliberately unsupported.
