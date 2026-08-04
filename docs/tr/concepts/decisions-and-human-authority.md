---
title: Kararlar ve insan yetkisi
description: İnsan kararını exact etki ve tek kullanımlık kanıta bağlayın.
---

> Compatibility: Pactmark 0.1.x.

## İnsan kararı

`Approval` serbest metin değildir. Yetkili host, authenticated actor için
`DecisionChallenge` üretir ve kararı exact tenant, run, effect, policy ve scope'a bağlar.

## Tek kullanımlık bağ

Opaque proof doğrudan decision endpoint'ine gider; model prompt'u, URL, log veya
evidence içine konmaz. Consume işlemi authority reservation ile atomiktir.

## Reddedilemeyen kontroller

İnsan authority kararı authentication, tenant isolation, grant, schema, budget,
SecretRef, egress veya uncertain-effect kuralını bypass edemez.
