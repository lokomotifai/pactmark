---
title: Agent ve WorkOrder
description: Tekrar kullanılabilir agent tanımını yetkilendirilmiş iş kabulünden ayırın.
---

> Compatibility: Pactmark 0.1.x.

## AgentDefinition

`AgentDefinition`; instruction, schema, tool, model profile, policy ve verifier
kimliklerini sürümlenmiş digest'lerde birleştirir. Aynı sürümde davranış değişimi
resume öncesinde reddedilir.

## WorkOrder

`WorkOrder`; tenant, principal, purpose, input, budget, deadline ve kabul edilen exact
definition'ı bağlar. Dış input schema doğrulamasına kadar `unknown` kalır.

## Yetki sınırı

Model içerik veya tool isteği önerebilir; authority, grant, Approval, credential,
budget veya effect acknowledgement üretemez. Bunlar host-controlled port'lardadır.
