---
title: Run yaşam döngüsü ve dayanıklılık
description: Append-only event truth, projection, suspension ve güvenli resume davranışını anlayın.
---

> Compatibility: Pactmark 0.1.x.

## Yaşam döngüsü

Doğrulanmış command'lar sürümlü `RunEvent` ekler. accepted, running, waiting,
verifying ve terminal state geçişleri kurallıdır; terminal sonrası mutation reddedilir.

## Dayanıklılık

Postgres profili idempotency, authority, event, reservation ve wake-up kayıtlarını
transaction sınırında bağlar. Projection yeniden üretilebilen cache'tir.

## Etki belirsizliği

Pactmark global exactly-once iddia etmez. Belirsiz etki, registered strategy güvenli
retry, reconciliation veya ayrı yetkili compensation yolu göstermeden park halinde kalır.
