---
title: Güvenlik modeli
description: Yetkiyi model context'inin dışında tutun ve belirsizlikte kapalı kalın.
---

> Compatibility: Pactmark 0.1.x.

## Güvenlik modeli

Model authority değildir. Authentication, tenant, default-deny policy, grant,
Approval, budget, schema, credential, egress, verification ve effect execution host'a aittir.

## Yetki

Her storage erişimi tenant kimliği taşır. Unknown metadata fail-closed davranır.
Current grant, policy digest ve kill switch her etki öncesi yeniden değerlendirilir.

## Gizli değerler

Resolved secret hiçbir zaman model context, event, telemetry, Artifact veya
EvidenceRecord içine girmez. `SecretRef` yalnız bound adapter içinde çözülür.

## Kalan risk

Bu kontroller tam güvenlik, compliance, sertifikasyon veya production isolation
kanıtlamaz. Deployment sahibi kendi tehdit modelini ve kalan riski onaylar.
