---
title: Terminoloji
description: Türkçe dokümanlarda kullanılan kanonik Pactmark terimleri.
---

> Compatibility: Pactmark 0.2.x.

API adları çevrilmez. Açıklayıcı Türkçe karşılık ilk kullanımda verilebilir.

| Kanonik terim   | Türkçe açıklama                                  |
| --------------- | ------------------------------------------------ |
| AgentDefinition | Agent'ın sürümlenmiş ve derlenmiş tanımı         |
| WorkOrder       | Yetki, amaç, input ve sınırları bağlayan iş emri |
| run             | Bir WorkOrder'ın olay-türevli yürütümü           |
| tool            | Policy ve executor üzerinden çağrılan araç       |
| CapabilityGrant | Belirli kapsam için verilen yetenek izni         |
| Approval        | Exact etkiye bağlanan insan kararı               |
| Artifact        | İçerik adresli iş çıktısı                        |
| Verifier        | Exact Artifact üzerinde çalışan doğrulayıcı      |
| EvidenceRecord  | Seçilmiş ve redakte edilmiş kanıt kaydı          |
| tenant          | Her erişim yoluna katılan müşteri/alan kimliği   |

`BUGÜN` yerel olarak çalışan ve kanıtı bulunan davranışı, `PİLOT` sınırlı veya canlı
doğrulaması eksik davranışı, `GELECEK` ise henüz ürün sözleşmesi olmayan yönü belirtir.
