---
title: Error reference
description: Handle stable KAF codes without parsing human-readable messages.
---

> Compatibility: Pactmark 0.1.x.

Pactmark failures expose stable `KAF_*` codes for schema, authority, tenant, policy,
grant, approval, budget, credential, effect, storage, migration, readiness, and
release boundaries. Messages remain English diagnostics and may change.

Fail-closed errors intentionally avoid revealing whether another tenant's resource,
secret, tool, or run exists. Logs and HTTP responses use separate disclosure levels.
Retry only when the typed classification and effect strategy permit it; timeouts and
transport loss do not imply that an external effect did not occur.
