---
title: Bellek, workspace, artifact ve evidence
description: Operasyonel context'i iş çıktısı ve kanıt iddiasından ayırın.
---

> Compatibility: Pactmark 0.1.x.

## Bellek ve bağlam

Memory ve `ContextStore` yürütüm/resume içindir; audit log değildir. Yalnız admitted,
tenant ve purpose-bound veri tutulur. Workspace path ve export sınırları capability'dir.

## Artifact

`Artifact` içerik adresli çıktıdır. Verifier exact bytes, registration ve rubric ile
bağlanır. İçeriğin gerçek veya amaca uygun olduğunu kendiliğinden kanıtlamaz.

## EvidenceRecord

`EvidenceRecord` seçilmiş event ve doğrulama iddialarını redaction sonrası taşır.
Hidden chain-of-thought değildir ve kapsamı dışındaki güvenlik/uyumluluk iddiasını desteklemez.
