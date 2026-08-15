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

Public registry, GitHub ayarları, canlı Vercel/Cloudflare ve production database
kanıtları readiness kaydında incelenmeden destek veya yayın iddiası yapılamaz.
