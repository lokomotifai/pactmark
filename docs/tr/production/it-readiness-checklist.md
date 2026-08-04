---
title: BT production hazırlık kontrol listesi
description: Kimlik, veri, dayanıklılık, kurtarma ve işletim kanıtlarını sahipleriyle kaydedin.
---

> Compatibility: Pactmark 0.1.x. İşaretli madde sertifika değil, ortama özgü kanıtlı karardır.

## Kimlik ve tenant

- Her command, stream, inspection ve decision yolunu authenticate edin.
- Tenant/principal bağını authority ve tüm storage erişimlerinde doğrulayın.
- Role, auth strength, grant, revocation ve break-glass sahiplerini atayın.

## Veri ve gizli değerler

- Model, tool, context, Artifact, audit ve telemetry verisini sınıflandırın.
- Hostname doğrulamalı TLS Postgres, least-privilege role ve key rotation kullanın.
- SecretRef, egress origin, region, retention, deletion ve backup akışlarını test edin.

## Dayanıklılık

- Migration, concurrency, cancellation, crash, lease-loss ve uncertain-effect testlerini çalıştırın.
- Ölçülmüş RPO ve RTO belirleyin; restore ve yeni process'te resume tatbikatı yapın.

## İşletim kararı

- Shared responsibility, monitoring, on-call, rollback ve incident owner'larını yazın.
- Credential leak ve malicious MCP drill'lerini tamamlayın; kalan riski kabul eden kişiyi kaydedin.
