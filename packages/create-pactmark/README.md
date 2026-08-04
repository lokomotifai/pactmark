# create-pactmark

Offline, deterministic project initializer for Pactmark. The package embeds its
versioned templates; it never downloads template source at runtime and never
asks for or reads provider secrets.

The public `npm create pactmark@latest` command remains planned until package
ownership and an authorized registry release are verified. A packed local
artifact can be exercised with:

```sh
npm exec --package=/absolute/path/create-pactmark-0.1.0.tgz create-pactmark -- \
  my-agent --template library --model mock-only --store memory \
  --package-manager npm --no-install --no-git
```

Run `create-pactmark --help` for the complete non-interactive interface.
`--dry-run --json` returns a stable plan and writes nothing. Memory-store
projects are explicitly ephemeral development demonstrations; production
readiness requires durable storage, host authentication, migrations, and any
requested isolation or enforced-egress capability.
