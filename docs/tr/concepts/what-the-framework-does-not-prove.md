---
title: Framework neyi kanıtlamaz
description: Production ve güvenlik iddiasından önce kanıt sınırlarını okuyun.
---

> Compatibility: Pactmark 0.2.x.

## Kanıtlanmayanlar

Pactmark global exactly-once, tam güvenlik, production izolasyonu, sertifikasyon,
compliance, availability, provider doğruluğu veya artifact gerçeği kanıtlamaz.

## Yerel kanıt

Green test yalnız belirtilen fixture, sürüm ve ortam için kanıttır. Memory store
dayanıklılık; reference sandbox production arbitrary-code isolation değildir.

## Harici doğrulama

v0.2.0 public registry baytları, package başına provenance ve GitHub Release kimliği
doğrulanmıştır. Bu sonuç; canlı Vercel/Cloudflare, production database, güvenlik,
sertifikasyon veya production readiness iddiası oluşturmaz.
