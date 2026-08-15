---
title: İlk agent'ınızı oluşturun
description: Model anahtarı olmadan deterministik bir Pactmark agent'ı çalıştırın.
---

> Compatibility: Pactmark 0.2.x candidate. Korumalı v0.2.0 publication ve bağımsız
> registry-byte doğrulaması henüz beklemektedir.

## Güncel yayımlanmış sürüm yolu

`npm create pactmark@latest -- my-agent` komutunu çalıştırın, `my-agent`
klasörüne geçin ve `npm run dev` komutunu çalıştırın. Kontrollü ortamlarda exact
version sabitleyin.

v0.2.0 publication kapısı kapanana kadar `latest`, doğrulanmış önceki public
sürüme çözülmeye devam eder.

`AgentDefinition` ve doğrulanmış `WorkOrder` akışının beklenen ilerlemesi sırasıyla
`RunAccepted`, `ToolCallCompleted` ve `RunCompleted` olaylarıdır. Üretilen proje
deterministik yerel model kullanır ve API key gerektirmez.

## Agent kaynağı

Site bu kaynağı doğrudan derlenmiş örnek fixture'dan içe aktarır:

<!-- pactmark:snippet source=examples/minimal-tool-agent/src/example.ts language=ts -->

## Yerel candidate doğrulaması

Katkıcılar `pnpm test:loopback-registry` komutunu çalıştırır. Bu kapı bütün
candidate paketlerini pack eder, geçici loopback registry'ye dependency-first
sırasıyla yayımlar, initializer'ı çalıştırır ve global npm konfigürasyonunu değiştirmez.

## Kurtarma

Kurulum not found döndürürse yapılandırılmış registry'yi, ağ erişimini ve istenen
sürümü doğrulayın. Doğrulanmamış benzer isimli bir pakete geçmeyin. Run hatasında
İngilizce mesajı parse etmeyin; kararlı `KAF_*` kodunu ve event akışını kullanın.
