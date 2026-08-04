---
title: Pactmark Türkçe dokümantasyonu
description: Sınırlandırılmış agent işleri, doğrulanan artifact'lar ve kanıt kayıtları.
template: splash
hero:
  tagline: Yetkiyi modelin dışında tutan kanıt-odaklı TypeScript agent framework'ü.
  actions:
    - text: İlk agent'ı oluştur
      link: /pactmark/tr/getting-started/first-agent
      icon: right-arrow
    - text: Güvenlik modelini oku
      link: /pactmark/tr/security/security-model
      variant: minimal
---

> Compatibility: Pactmark 0.1.x. Yayın durumu **bekliyor**. npm komutlarını
> kullanmadan önce güncel readiness kaydında registry yayınının doğrulandığını kontrol edin.

Pactmark, doğrulanmış bir `WorkOrder`'ı sınırlandırılmış run, yönetilen tool etkileri,
doğrulanmış `Artifact` ve `EvidenceRecord` akışına dönüştürür. Policy, grant,
Approval, budget, credential ve etki yürütümü model yetkisinin dışındadır.

Yerel testler canlı deployment, global exactly-once, sertifikasyon veya production
izolasyonu kanıtlamaz.
