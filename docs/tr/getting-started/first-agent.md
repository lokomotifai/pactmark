---
title: İlk agent'ınızı oluşturun
description: Model anahtarı olmadan deterministik bir Pactmark agent'ı çalıştırın.
---

> Compatibility: Pactmark 0.1.x. Public release henüz doğrulanmadı.

## BUGÜN

`AgentDefinition` ve `WorkOrder` akışı yerel paketler, loopback registry ve
deterministik model ile test edilir. Registry'de benzer isimli doğrulanmamış paket
kullanmayın.

## Komutlar

Yayın doğrulandıktan sonra `npm create pactmark@latest -- my-agent`, ardından
`cd my-agent` ve `npm run dev` çalıştırın. Kontrollü ortamlarda exact version sabitleyin.

## Beklenen sonuç

Akış sırasıyla `RunAccepted`, `ToolCallCompleted` ve `RunCompleted` üretir. API key
gerekmez. Artifact ve doğrulama sonucu terminal run üzerinden incelenebilir.

## Hata kurtarma

Not found hatası yayının beklediğini gösterebilir. Run hatasında İngilizce mesajı
parse etmeyin; kararlı `KAF_*` kodunu ve event akışını kullanın. Katkıcılar exact
paketleri sınamak için `pnpm test:loopback-registry` çalıştırır.
