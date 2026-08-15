---
title: İlk agent'ınızı oluşturun
description: Model anahtarı olmadan deterministik bir Pactmark agent'ı çalıştırın.
---

> Compatibility: Pactmark 0.2.x. 0.2.0 sürümü, doğrulanmış registry byte'ları
> ve paket başına provenance ile npm'de public olarak yayımlanmıştır.

## Yayımlanmış sürüm yolu

`npm create pactmark@latest -- my-agent` komutunu çalıştırın, `my-agent`
klasörüne geçin ve `npm run dev` komutunu çalıştırın. Kontrollü ortamlarda exact
version sabitleyin.

Beklenen ilerleme sırasıyla `RunAccepted`, `ToolCallCompleted` ve `RunCompleted`
olaylarıdır. Üretilen proje deterministik yerel model kullanır ve API key gerektirmez.

## Yerel candidate doğrulaması

Katkıcılar `pnpm test:loopback-registry` komutunu çalıştırır. Bu kapı bütün
candidate paketlerini pack eder, geçici loopback registry'ye dependency-first
sırasıyla yayımlar, initializer'ı çalıştırır ve global npm konfigürasyonunu değiştirmez.

## Kurtarma

Kurulum not found döndürürse yapılandırılmış registry'yi, ağ erişimini ve istenen
sürümü doğrulayın. Doğrulanmamış benzer isimli bir pakete geçmeyin. Run hatasında
İngilizce mesajı parse etmeyin; kararlı `KAF_*` kodunu ve event akışını kullanın.
