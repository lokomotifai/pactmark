---
title: Authentication and tenancy
description: Bind every command and storage access to authenticated tenant authority.
---

> Compatibility: Pactmark 0.2.x.

HTTP adapters receive an injected authenticator. The host maps verified credentials
to principal, tenant, authentication strength, roles, and purpose; user input cannot
select these values. Missing authentication fails before storage or model access.

Every store method includes tenant identity and negative tests cover cross-tenant
reads and mutations. Command idempotency is scoped by authority and request digest.
Background workers use delegated authority bound to the initiating subject and audit
their own actor identity.

Operators own tenant provisioning, deprovisioning, membership, session revocation,
break-glass access, and periodic authorization review.
