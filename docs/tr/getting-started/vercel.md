---
title: Vercel deployment
description: Vercel adapter'ını invocation süresini dayanıklılık sanmadan kullanın.
---

> Compatibility: Pactmark 0.2.x.

## BUGÜN

`@pactmark/vercel`, Next route, security ve accessibility contract testlerinden
geçer. Bu yerel kanıttır; canlı deployment kanıtı değildir.

## PİLOT

Canlı preview; exact vendored tarball, frozen lockfile, hostname doğrulamalı TLS
Postgres, authenticated principal ve ayrı invocation'da resume kanıtı gerektirir.

## Sınırlar

Uzun function timeout dayanıklılık sağlamaz. Memory profile production için hazır
değildir. URL, log, database state, rollback ve teardown incelenmeden Vercel desteği
canlı doğrulanmış olarak tanımlanamaz.
