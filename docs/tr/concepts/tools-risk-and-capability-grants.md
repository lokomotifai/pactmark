---
title: Tool, risk ve capability grant
description: Tool görünürlüğünü default-deny policy ve exact grant ile sınırlayın.
---

> Compatibility: Pactmark 0.1.x.

## Risk

`ToolSecurity`; risk, scope, effect strategy, egress, credential mode ve resource
limitlerini taşır. Eksik veya bilinmeyen metadata default-deny sonucu verir.

## Grant

`CapabilityGrant`; tenant, principal, purpose, ToolSecurity registration, scope,
expiry ve constraint'leri bağlar. Tek kullanımlık reservation replay'i kapatır.

## Modelin rolü

Model grant oluşturamaz, secret çözemez ve instruction değiştirerek reddedilen tool'u
erişilebilir yapamaz. Policy her effect öncesi güncel grant ve kill switch'i kontrol eder.
