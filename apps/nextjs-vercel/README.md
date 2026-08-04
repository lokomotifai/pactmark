# Pactmark Next.js + Vercel fixture

This is a real Next.js App Router host for the deterministic Pactmark agent. The default preview profile uses process-local memory, shows an explicit demo banner, requires no provider key, and makes no durability or automatic-background-continuation claim.

```sh
pnpm --filter nextjs-vercel typecheck
pnpm --filter nextjs-vercel test
pnpm --filter nextjs-vercel build
pnpm --filter nextjs-vercel doctor:preview
```

`doctor:production` intentionally fails until authenticated durable Postgres storage, migrations, admission/quota/circuit breakers, protected records, lease/resume, and governed effects are composed. `migrate:postgres` also fails closed in this fixture; it never pretends a migration happened.

The Vercel CLI is deliberately not a local dependency: its large advisory-bearing transitive graph is excluded from the required install. The `deploy:*` commands pin `npx --yes vercel@58.4.4`, but remain external live actions that require network access, Vercel authentication, and separate authorization. They have not been executed. No Deploy Button is published before a verified public template URL exists.

All API routes are mounted at `/api/agent`. The UI renders external content as React text, uses no Markdown or raw HTML, keeps decision challenge proof only in short-lived JavaScript memory, and clears it after use, failure, expiry, or unmount.
