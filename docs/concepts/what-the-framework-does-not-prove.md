---
title: What Pactmark does not prove
description: Read the limits before making production or security claims.
---

> Compatibility: Pactmark 0.2.x.

Pactmark does not prove global exactly-once effects, complete security, sandbox
isolation, certification, compliance, production availability, provider correctness,
or artifact truth. Local green tests do not constitute a live platform attestation.

The reference sandbox is explicitly unsafe for production arbitrary-code isolation.
The Vercel and Cloudflare packages have local contract evidence only. The memory
store is not production durability. Public release ownership is verified for
earlier versions; v0.2.0 protected publication and independent registry-byte
verification remain pending. Neither state establishes any of the production or
security claims excluded above.
