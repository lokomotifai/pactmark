---
title: Üretim korumalı Executor gateway
description: Pactmark authority sınırını devretmeden incelenmiş salt-okunur Executor araçlarını bağlayın.
---

> Compatibility: Pactmark 0.2.x. Durum: **özel, üretim korumalı entegrasyon**.

`@pactmark/executor-sh`, incelenmiş Executor araçlarını bağımsız Pactmark registration değerlerine
eşler. Önceden korumalı biçimde kurulmuş bir `@pactmark/mcp` connection kullanır; ancak Executor'ın
genel amaçlı `execute(code)` registration değerini modele vermez. Paket özeldir, yayımlanmamıştır ve
sabitlenmiş v0.1 public package kümesinin dışındadır.

## Yetki sınırı

Risk, grants, amaç, budgets, approval, retry sınıflandırması ve evidence için authority Pactmark'tır.
Executor entegrasyon protokolünü yönetir ve sakladığı connection credential değerini upstream isteğine
ekleyebilir. Executor policy ve toolkit ayarları yalnızca ek savunma katmanıdır.

Adapter yalnızca `effectStrategyKind: "read"`, `R0`/`R1`,
`reversibility: "not_applicable"`, bildirimli allowlist egress ve
`networkEnforcement: "declared_ok"` registration değerlerini kabul eder. İncelenen işlem anlamsal
olarak salt-okunur olduğunda upstream `POST` kullanılabilir; bu sınıflandırmayı HTTP metodu veya
Executor metadata yerine operatör yapmalıdır.

## Üretim kabulü

Entegrasyon Executor `v1.5.40`, source revision
`b029643641832ef5f9b0d4ff263d96e1a5b2739c` ve OCI index digest
`sha256:3e9792043be7819361eada0c5c87ebfa66e996e15772f75a39aae76facd4cb88` değerlerini sabitler. Bu
digest'i bootstrap ettikten sonra exact container kapısını çalıştırın: önce
`pnpm bootstrap:executor-sh-image`, ardından `pnpm test:executor-sh-container`.

Host, en fazla yedi gün geçerli bir receipt ve onunla eşleşen production deployment profile
sağlamalıdır. Profile; bir tenant'ı tek bir Executor instance, exact sistem güvenli HTTPS origin, opak
connection reference, platform manifest ve receipt değerlerine bağlar. Ayrıca telemetry, analytics,
local-network erişimi ve stdio MCP'nin kapalı olmasını; UID/GID 65532; read-only root; düşürülmüş
capabilities; `no-new-privileges`; ayrılmış şifreli data volume ve adlandırılmış backup policy ister.

Receipt digest, kaydedilen gözlemdeki drift'i saptar. İmza, remote attestation, certification veya
rastgele bir production host hakkında kanıt değildir. Yalnızca güvenilir bir deployment controller
içinde oluşturulup kabul edilmelidir. Bildirilen araç bazlı egress allowlist'i altyapıda uygulayın;
Executor'ın local/private-address koruması exact araç bazlı egress enforcement değildir.

## Host bağlantısı

Host, Executor HTTPS endpoint, server identity, `execute` schema, credential origin, amaç ve grant
bilgilerini sabitleyen bir `MCPConnection` kurar. Bu connection ve açığa çıkarılmış `execute`
registration değerini modelin görebildiği tüm registry yüzeylerinin dışında tutun.

Ardından tenant deployment profile ile exact upstream tool pin'i bağlayın:

<!-- pactmark:snippet source=docs/snippets/executor-sh-host-wiring.ts language=ts -->

Pin exact server, Executor `execute` registration, connection reference, address, schemas, security
metadata, effect strategy ve code-template version değerlerini birbirine bağlar. Catalog discovery
bunu otomatik olarak güncellemez. Bir değişiklik yeni, incelenmiş pin ve registration version
gerektirir.

## Runtime davranışı

Her invocation için adapter deployment profile ve güncel receipt değerini doğrular; exact Pactmark
registration ve input schema değerlerini denetler; canonical JSON'dan sabit tek çağrılık script üretir;
sabitlenmiş MCP `execute` aracını bir kez çağırır; paused/error durumlarını reddeder; dönen result schema
değerini doğrular ve Executor logs alanını dönüş yüzeyine taşımaz.

Connection ve upstream hataları yalnızca güvenli `KAF_EXECUTOR_*` kodlarıyla dışarı verilir.
Salt-okunur transport hataları retryable olarak sınıflandırılabilir; bu sınıflandırma gelecekteki bir
write adapter'a kopyalanmamalıdır.

## Çalıştırılabilir kanıt

Digest ile sabitlenmiş yerel Docker fixture; non-root/read-only sertleştirme, resource limits, restart
persistence, durmuş volume backup/restore, telemetry ve analytics opt-out, reddedilen outbound ve
private networking, kapalı stdio MCP, unauthenticated denial, API-key MCP, OAuth PKCE, cross-tenant
credential denial, canary-safe logs ve gerçek `execute` envelope davranışını doğrular.

Ayrı network-authorized kapı `pnpm test:executor-sh-read-tools:live`, gerçek self-hosted Executor MCP
yolu üzerinden altı GET-only NPM download işlemini kaydeder ve çağırır.

Bu kapı harici write yapmaz ve SaaS credential kullanmaz. `pnpm test:executor-sh-packed`, yalnızca
paketlenmiş `core`, `mcp` ve `executor-sh` tarball değerlerini bağımsız biçimde kurar; CI bu kapıyı
Node.js 22 ve 24 üzerinde çalıştırır.

## Desteklenmeyen ve kanıtlanmayan

- Writes, automatic approval, `resume` ve çok çağrılı code programları desteklenmez.
- Executor catalog kayıtları ve policy annotations, Pactmark registration veya grant oluşturmaz.
- Adapter `sandbox: "unsafe_local"` ve `networkPolicy: "declared"` bildirir.
- Paylaşımlı multi-tenant Executor instance değerleri deployment contract tarafından reddedilir.
- Fixture; arbitrary-code isolation, container-escape direnci, availability veya ayrı bir production
  environment yapılandırmasını kanıtlamaz.
- Her production target için güvenilir TLS termination, encrypted volume/key management,
  backup/restore işletimi, exact egress controls, monitoring, credential rotation ve target'a özel
  güncel receipt yine gereklidir.
