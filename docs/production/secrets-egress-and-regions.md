---
title: Secrets, egress, and regions
description: Keep credentials out of model context and constrain every network destination.
---

> Compatibility: Pactmark 0.1.x.

Store secrets in a host-managed secret system. Pactmark issues opaque, short-lived,
purpose-bound `SecretRef` values only after authority and policy succeed. The target
adapter resolves the value immediately before invocation. Never persist or emit the
resolved value.

Route external traffic through an injected egress broker with normalized exact
origins, DNS/IP controls, redirect policy, TLS verification, byte/time limits, and
credential-origin binding. Model or tool content cannot select an undeclared endpoint.

Pactmark does not choose a region or promise residency. Record the regions and data
paths of the host, database, artifact store, model provider, tools, logs, backups,
and support systems.
