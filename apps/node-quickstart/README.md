# Pactmark Node quickstart

This is the executable, deterministic Node host. It uses a memory runtime and anonymous local
development authority, so it is intentionally **ephemeral** and never production-ready.

```sh
pnpm --filter pactmark-node-quickstart dev
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
```

`/readyz` returns `503` because durable storage, protected production inputs, model credentials,
and an isolated sandbox are not configured. The app honors `PORT`, streams through the standard
Node bridge, and installs graceful `SIGTERM` handling.

The container runs as the non-root `node` user. Build it from the repository root with
`pnpm --filter pactmark-node-quickstart container:build`. Container verification remains a local
release gate and is not evidence of a managed production sandbox.
