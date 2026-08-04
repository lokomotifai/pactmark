# Bounded workspace agent

The default-deny fixture can read `workspace/**` and write draft artifacts only. It denies absolute paths, parent traversal, backslashes, and symlinks before dispatch. Command, output, and time budgets are enforced outside agent instructions. Secrets are redacted before results leave the adapter.

The virtual adapter is deterministic test proof. The named unsafe-local development profile is explicitly not a production security boundary.
