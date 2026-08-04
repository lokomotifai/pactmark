---
title: Node ve OCI container
description: Node adapter'ını geliştirme veya dayanıklı Postgres profiliyle çalıştırın.
---

> Compatibility: Pactmark 0.1.x.

## BUGÜN

Node/OCI fixture network kapalı build, non-root user, read-only filesystem, health,
readiness, stream ve terminal inspection davranışlarını yerelde doğrular.

## Üretim profili

Postgres migrations, hostname doğrulamalı TLS, least-privilege role, fenced lease,
protected context, backup ve ayrı worker gerekir. Memory store yalnız geliştirme içindir.

## Kurtarma

SIGTERM sırasında yeni işi durdurun ve persisted event'lerden yeni process'te resume
edin. Belirsiz external effect'i yalnız registered strategy retry'ın güvenli olduğunu
kanıtlarsa tekrarlayın.
