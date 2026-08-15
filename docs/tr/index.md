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

> Compatibility: Pactmark 0.2.x. 0.2.0 sürümü, doğrulanmış registry byte'ları
> ve paket başına provenance ile npm'de public olarak yayımlanmıştır.

Pactmark, doğrulanmış bir `WorkOrder`'ı sınırlandırılmış run, yönetilen tool etkileri,
doğrulanmış `Artifact` ve `EvidenceRecord` akışına dönüştürür. Policy, grant,
Approval, budget, credential ve etki yürütümü model yetkisinin dışındadır.

Yerel testler canlı deployment, global exactly-once, sertifikasyon veya production
izolasyonu kanıtlamaz.
