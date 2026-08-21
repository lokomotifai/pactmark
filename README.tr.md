<p align="center">
  <a href="https://pactmark-docs.lokomotif.ai/tr">
    <img src="assets/brand/pactmark-logo.svg" width="132" height="132" alt="Pactmark">
  </a>
</p>

<h1 align="center">Pactmark</h1>

<p align="center"><strong>Yalnızca yanıt değil, kanıt bırakan kontrollü TypeScript agent’ları.</strong></p>

<p align="center">
  Doğrulanmış bir <code>WorkOrder</code>’ı sınırlandırılmış çalışma, kontrollü tool etkileri,<br>
  içerik adresli artifact’ler, tanımlı verification ve <code>EvidenceRecord</code> sonucuna dönüştürür.
</p>

<p align="center">
  <a href="https://github.com/lokomotifai/pactmark/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lokomotifai/pactmark/ci.yml?branch=main&amp;style=flat-square&amp;label=CI"></a>
  <a href="https://github.com/lokomotifai/pactmark/actions/workflows/security.yml"><img alt="Güvenlik temel hattı" src="https://img.shields.io/github/actions/workflow/status/lokomotifai/pactmark/security.yml?branch=main&amp;style=flat-square&amp;label=security"></a>
  <a href="https://www.npmjs.com/package/@pactmark/agent"><img alt="npm sürümü" src="https://img.shields.io/npm/v/%40pactmark%2Fagent?style=flat-square&amp;label=npm&amp;color=D11F26"></a>
  <a href="https://github.com/lokomotifai/pactmark/releases/tag/v0.2.0"><img alt="v0.2.0 doğrulanmış release" src="https://img.shields.io/badge/release-v0.2.0%20verified-D11F26?style=flat-square"></a>
  <a href="LICENSE"><img alt="Apache-2.0 lisansı" src="https://img.shields.io/badge/license-Apache--2.0-3B3F46?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img alt="Node.js 22 ve 24" src="https://img.shields.io/badge/Node.js-22%20%7C%2024-3C873A?style=flat-square"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square"></a>
  <a href="https://pactmark-docs.lokomotif.ai/tr"><img alt="Türkçe dokümantasyon" src="https://img.shields.io/badge/dokümantasyon-Türkçe-D11F26?style=flat-square"></a>
  <a href="README.md"><img alt="English README" src="https://img.shields.io/badge/README-English-17191F?style=flat-square"></a>
  <a href="https://github.com/lokomotifai/pactmark/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/lokomotifai/pactmark?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://pactmark-docs.lokomotif.ai/tr/getting-started/first-agent"><strong>İlk agent’ı oluştur</strong></a>
  ·
  <a href="https://pactmark-docs.lokomotif.ai/tr"><strong>Dokümantasyonu oku</strong></a>
  ·
  <a href="examples/approval-agent/"><strong>Approval sınırını incele</strong></a>
  ·
  <a href="README.md"><strong>English</strong></a>
</p>

---

> **Model hiçbir zaman otorite değildir.** Bir tool çağrısı önerebilir; kendine
> scope veremez, kendi riskini onaylayamaz, credential çözümleyemez, bütçeyi
> genişletemez veya çıktısını doğrulanmış ilan edemez.

Pactmark, açık yetki altında sınırlandırılmış işler yapan agent’lar için
kanıt-yerel bir framework’tür. “Model makul bir şey döndürdü” ifadesinin başarı
tanımı olamayacağı sistemler için tasarlanmıştır.

**0.2.0** public olarak yayımlanmıştır: 18 `@pactmark/*` package’ı ve scope’suz
`create-pactmark` initializer’ı. Private `@pactmark/executor-sh` workspace’i 0.1.0
sürümünde kalır ve public release artifact’lerine dâhil edilmez. Korumalı OIDC
workflow’u, anonim registry doğrulaması ve immutable GitHub Release; registry’nin
sunduğu her tarball’ın frozen release manifest’iyle eşleştiğini ve npm SLSA
provenance taşıdığını doğrular. Bu tedarik zinciri sonuçları production deployment
hazırlığı veya framework güvenliği sertifikası değildir.

`main` dalı 0.2.0’da bulunmayan işleri de taşır. [CHANGELOG.md](CHANGELOG.md)
yayımlanmış davranışı yayımlanmamış davranıştan ayırır; bu README de farkı,
belgelenmiş bir yolu etkilediği her yerde işaretler.

## Tek görselde temel fark

![Model çıktısının host kontrollü bir etkiye dönüşmeden önce Pactmark schema, policy, capability, approval, budget ve dispatch sınırlarından geçtiğini gösteren diyagram](assets/readme/authority-boundary.png)

<p align="center"><sub><a href="assets/readme/authority-boundary.svg">Erişilebilir SVG kaynağını görüntüle</a></sub></p>

Pek çok agent kütüphanesi model çağrısını ve tool bağlantısını kolaylaştırır.
Pactmark, o çağrının çevresindeki sorumluluğu tanımlar:

| Soru                                           | Pactmark’ın yanıtı                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Agent ne yapabilir?                            | Doğrulanmış iş sözleşmesi, default-deny policy, capability grant’leri, risk sınıfı ve bütçe belirler.             |
| Sonuç doğuran bir eylemi kim onaylar?          | Model metni değil; exact run ve effect’e bağlanmış, host tarafından üretilen karar.                               |
| Provider ve tool credential’ları nerede yaşar? | Host’un credential port’larının arkasında; çözümlenmiş değerler model context’ine veya sıradan evidence’a girmez. |
| Crash sonrasında ne olur?                      | Append-only run truth üzerinden durum yeniden kurulur; belirsiz effect kayıtlı stratejiyle reconcile edilir.      |
| Çalışma gerçekten ne üretti?                   | Tanımlı verifier sonuçlarına bağlı, içerik adresli artifact’ler.                                                  |
| Başka bir sistem neye güvenebilir?             | Sınırları açık, self-attested bir `EvidenceRecord`; taşınabilir authenticity ayrıca host imzası gerektirir.       |

## 60 saniyede başla

Initializer, deterministic yerel bir agent oluşturur. Model anahtarı istemez ve
global npm ayarını değiştirmez.

```sh
npm create pactmark@latest -- my-agent
cd my-agent
npm run dev
```

Beklenen ilerleme kayıtları arasında şunlar bulunur:

```text
RunAccepted
ToolCallCompleted
VerificationRecorded(status=pass)
RunCompleted
```

Oluşturulan proje bilinçli olarak ephemeral local profile kullanır: in-memory
state, deterministic model fixture ve güvenilen in-process execution. Bu bir
öğrenme/test yoludur; production template’i gibi sunulmaz.

Tek tool’lu, yönetişimli bir agent yaklaşık otuz satıra sığar
([`examples/quickstart-agent`](examples/quickstart-agent/), anahtar gerektirmeden
çalışır):

> **Henüz yayımlanmamış yüzey.** Ham Zod şemaları, string `instructions`,
> varsayılan local policy ve `runtime.run(...)` `main` dalındadır ve yayımlanmış
> 0.2.0’ın parçası değildir. 0.2.0 üzerinde bunun yerine
> [`examples/minimal-tool-agent/src/example.ts`](examples/minimal-tool-agent/src/example.ts)
> içindeki açık formu kullanın.

```ts
const lookup = defineTool({
  id: "catalog.lookup@1",
  description: "Read one item from the embedded catalog.",
  input: z.object({ sku: z.string().min(1) }).strict(),
  output: z.object({ sku: z.string(), name: z.string(), available: z.boolean() }).strict(),
  security: { requiredScopes: ["catalog:read"] },
  operation: {
    kind: "read",
    execute: ({ sku }) =>
      Promise.resolve({ sku, name: "Portable notebook", available: sku === "P-100" }),
  },
});

const catalogAgent = defineAgent({
  id: "quickstart-catalog-agent",
  version: "0.1.0",
  input: z.object({ sku: z.string().min(1) }).strict(),
  instructions: "Check the catalog with the lookup tool, then answer with the output JSON.",
  model: fromAISDK(model()),
  tools: { lookup },
  output: z.object({ summary: z.string() }).strict(),
});

const runtime = createLocalRuntime({ agents: [catalogAgent] });
const result = await runtime.run(catalogAgent, {
  goal: "Check availability of SKU P-100.",
  input: { sku: "P-100" },
});
```

`model()` herhangi bir AI SDK v7 model örneğidir; örnek, anahtarsız çalışabilsin
diye provider biçimli deterministic bir fixture ile gelir. Tool’lar sağlayıcıya
yalnızca şema olarak tanıtılır; her öneri dispatch öncesi host tarafından yeniden
doğrulanır ve policy’den geçer. Facade varsayılanları yetkiyi asla genişletmez:
okumalar R1’e varsayılanır, yazma R2 ve açık policy kuralı ister, varsayılan
policy geri kalan her şeyi reddeder. Eksiksiz açık formda —model güvenlik/kaynak
profilleri, authority issuer, `WorkOrder`, purpose ve data class, istenen
capability’ler, bütçeler ve command identity— her şey
[`examples/minimal-tool-agent/src/example.ts`](examples/minimal-tool-agent/src/example.ts)
içinde açıkça tanımlıdır.

## Ürün sınırı run’dır

![Bir Pactmark run’ının WorkOrder’dan admission, bounded work, artifact ve verification üzerinden EvidenceRecord’a ilerleyişini gösteren diyagram](assets/readme/run-lifecycle.png)

<p align="center"><sub><a href="assets/readme/run-lifecycle.svg">Erişilebilir SVG kaynağını görüntüle</a></sub></p>

Her run runtime’da doğrulanan bir `WorkOrder` ile başlar. Work order şunları
birbirine bağlar:

- agent identity ve version;
- goal ve typed input;
- principal, tenant, purpose, data class ve retention;
- work/autonomy mode ve human decision owner;
- talep edilen capability’ler; ve
- turn, model call, tool call, token, byte ve active-time bütçeleri.

Admission, bilinmeyen veya runtime’ın desteklemediği metadata’yı reddeder. Çalışma
boyunca model ve tool I/O güvenilmez kabul edilir. Önerilen bir effect, dispatch
öncesinde schema validation, policy, grant, risk, approval, budget ve runtime
capability kontrollerinden geçer. Terminal başarı, tanımlı verification yolunu
gerektirir; doğal dildeki “tamamlandı” beyanının otoritesi yoktur.

### “Exactly once” sloganı olmadan dayanıklılık

Pactmark append-only event’leri run truth olarak saklar; projection’ları yeniden
üretilebilir cache olarak görür. Durable profiller lease, operation key,
authorization reservation, acknowledgement, checkpoint ve kayıtlı
reconciliation/compensation stratejilerini kullanır.

Bu yapı, test edilen belirli stratejilerin belirli crash sınırlarında daha önce
alındısı kaydedilmiş effect’i tekrar etmesini engelleyebilir. Herhangi bir dış
API’yi evrensel olarak exactly-once hâle getirmez. Effect sonucunun belirsiz
olduğu ve stratejinin retry’ın güvenli olduğunu kanıtlayamadığı durumda Pactmark
sessizce yeniden dispatch etmek yerine fail closed davranır.

## Mimari

Portable kernel Node built-in’lerini, environment variable’ları, platform SDK’larını,
provider SDK’larını veya storage implementasyonlarını import etmez. Host ve vendor
davranışı açık adapter’lardan girer.

```text
application / host
        │
        ├── authority · credentials · scheduler · executor · network controls
        │
   @pactmark/agent        ergonomik composition
        │
   ┌────┴───────────────────────────────────────────────┐
   │ portable kernel                                   │
   │ core ── runtime ── policy ── evidence             │
   └────┬───────────────────────────────────────────────┘
        │ ports
   ┌────┴───────────────────────────────────────────────┐
   │ stores · protocols · model adapters · host bridges│
   └────────────────────────────────────────────────────┘
```

Dependency graph ve package sınırları
[`docs/architecture/dependencies.md`](docs/architecture/dependencies.md) içinde
belgelenir. Deep import ve cycle’lar repository kontrollerinde reddedilir.

### Package haritası

| Katman                         | Paketler                                                                          | Sorumluluk                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Facade ve kernel               | `@pactmark/agent`, `core`, `runtime`, `policy`, `evidence`                        | Public composition, versioned contract’lar, orchestration, authority kuralları, artifact ve evidence. |
| Storage ve execution           | `store-memory`, `store-postgres`, `driver-postgres-worker`, `executor-in-process` | Ephemeral test, tenant-scoped durable state, worker loop ve güvenilen in-process tool execution.      |
| Interface’ler                  | `http`, `node`, `mcp`, `cli`                                                      | Web-standard HTTP/SSE, Node lifecycle, guarded MCP client ve terminal-safe command’lar.               |
| Platform/provider adapter’ları | `ai-sdk`, `vercel`, `cloudflare`, `otel`                                          | Vendor/platform dependency’lerini kernel’a taşımadan opt-in entegrasyon.                              |
| Contributor tooling            | `testing`, `create-pactmark`                                                      | Deterministic fake/contract suite’leri ve offline-capable initializer.                                |

Yalnızca host’unuzun sahip olduğu paketleri kurun. `@pactmark/agent` optional
provider, database, platform adapter veya telemetry paketlerini re-export etmez.

## Framework neyi korur, neyi koruyamaz?

- **Default deny:** bilinmeyen policy, scope, risk, metadata veya runtime desteği
  tahmin edilmez; reddedilir.
- **Her storage yolunda tenant:** tenant kimliği edge’de isteğe bağlı bir filtre
  değildir.
- **Credential’lar opaque kalır:** model ve normal diagnostics yalnızca referans
  alır, çözümlenmiş değerleri değil.
- **Human decision bağlıdır:** approval exact challenge, effect, tenant, grant ve
  expiry’ye scope edilir.
- **Evidence çalışma alanından daha dardır:** hidden chain-of-thought saklanmaz ve
  kanıt diye sunulmaz.
- **Host sorumluluğu devam eder:** network isolation, identity, secret storage,
  retention, backup, provider koşulları ve incident response bunları gerçekten
  uygulayan deployment’a aittir.

Pactmark genel amaçlı chat SDK’sı, no-code builder, swarm orchestrator, hosted
control plane veya production arbitrary-code sandbox değildir. Güvenilen
in-process executor bir isolation boundary değildir. Production-shaped host
değerlendirmeden önce [güvenlik modelini](https://pactmark-docs.lokomotif.ai/tr/security/security-model)
okuyun.

## Runtime ve platform durumu

| Yüzey                   | Mevcut kanıt                                                                                  | Sınır                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Local memory runtime    | Deterministic unit, integration, consumer, replay, cancellation ve concurrency testleri       | Ephemeral development/test profili; production readiness false döner.           |
| PostgreSQL store/worker | Gerçek PostgreSQL migration, tenant, lease, checkpoint/resume, TLS ve crash-boundary kapıları | Database operations, scheduling, credential, backup ve isolation host’a aittir. |
| Node ve OCI             | HTTP/SSE contract’ları ve read-only, network-bounded local container conformance fixture      | Registry, multi-architecture veya production availability iddiası yoktur.       |
| Next.js / Vercel        | Adapter, route, auth-denial, UI security/accessibility ve geçmiş protected Preview kanıtı     | Güncel Vercel Production deployment veya production support iddiası yoktur.     |
| Cloudflare Workers      | Experimental Web-standard adapter, dry-run testleri ve ephemeral staging deployment           | Durable production gereksinimleri için readiness bilinçli olarak başarısızdır.  |
| MCP                     | Açık security metadata ile deterministic stdio ve HTTP client contract’ları                   | Uzak MCP server ve tool’ları güvenilmeyen dış sistemlerdir.                     |
| OpenTelemetry           | Opt-in, varsayılan metadata-only adapter testleri                                             | Export edilen veriyi host konfigürasyonu değiştirir ve ayrıca incelenmelidir.   |

Kesin command, tarih, digest ve açık eksikler
[`v0.2 readiness kaydında`](docs/releases/v0.2-readiness.md) yer alır. Bu kayıt
bilinçli olarak bir feature checklist’inden daha muhafazakârdır.

## Release bütünlüğü

- npm publication, GitHub Actions OIDC trusted publishing kullanır.
- Release candidate `pnpm verify` kapısından geçer.
- Paketler bağımsız consumer artifact’leri olarak pack edilir ve incelenir.
- Candidate tarball’lar tekrar üretilerek karşılaştırılır.
- Frozen candidate; SHA-256 checksum, source/release manifest ve CycloneDX SBOM
  içerir; korumalı publication npm provenance ve GitHub attestation ekler.
- Anonim doğrulama; 19 v0.2.0 registry tarball’ını, package source metadata’sını,
  `latest` tag’lerini ve SLSA provenance kayıtlarını frozen release ile eşleştirdi.
- Immutable [v0.2.0 GitHub Release](https://github.com/lokomotifai/pactmark/releases/tag/v0.2.0),
  19 tarball ile yedi checksum, manifest, SBOM ve attestation asset’ini saklar.

[v0.2.0 release kanıtı](docs/releases/v0.2-readiness.md), her kapının kesin
durumunu gösterir. Provenance bir artifact’in nereden geldiğini gösterir;
davranışını sertifikalandırmaz.

## Repository’yi geliştir

Pactmark development için Node.js 24 ve pnpm 11.18.0 kullanır. Desteklenen
release satırları Node.js 22.14+ ve 24.x’tir.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Normal geliştirme döngüsünde `pnpm check`, deterministic pull request yüzeyi için
`pnpm verify:ci`, release öncesinde `pnpm verify` kullanılır. Release aggregate;
format, lint, strict type, build, unit/integration, packed
consumer, portability, example, PostgreSQL, crash/replay, OCI/platform contract,
API report, dependency boundary, security audit, SBOM, dokümantasyon ve release
dry-run kapılarını çalıştırır. Live provider çağrıları, external deployment ve
network-fresh advisory kontrolleri ayrı yetkilendirilmiş kapılardır.

Katkı göndermeden önce [CONTRIBUTING.md](CONTRIBUTING.md) dosyasını okuyun.

Public hatalar legacy `KAF_*` v0.1 wire-code namespace’ini kullanır. Bu namespace consumer
uyumluluğu için korunur, ayrı bir ürün adı değildir; client’lar tam hata kodunu opaque ve kararlı
bir identifier olarak ele almalıdır.

## Topluluk sözleşmesi

Pactmark bugün founder-led yönetilir. Governance modeli, yalnızca gerçek
contributor’lar açık bir scope’un sorumluluğunu almaya hazır olduğunda daha az
merkezî hâle gelecek şekilde kurulmuştur; hayalî komite veya contribution
sayısıyla otomatik yetki yoktur.

| Dosya                                    | Projenin taahhüdü                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Contributing](CONTRIBUTING.md)          | Tekrarlanabilir setup, review standardı, eklemeli DCO/CLA koşulları, AI-assisted contribution politikası ve acceptance kriterleri. |
| [Contributor agreements](CLA/README.md)  | Taslak CLA durumu, geriye yürümeyen kapsam, imza yolu ve hukuk incelemesi sınırı.                                                  |
| [Governance](GOVERNANCE.md)              | Roller, karar sınıfları, public RFC/ADR yolu, conflict, maintainer geçişi ve founder-led sınırlar.                                 |
| [Maintainers](MAINTAINERS.md)            | İsimler, scope’lar, hassas capability’ler ve doğrulanmış contact route’ları.                                                       |
| [Code of Conduct](CODE_OF_CONDUCT.md)    | Katılım standardı, private reporting, conflict ve ölçülü yaptırım basamakları.                                                     |
| [Security](SECURITY.md)                  | Desteklenen sürümler, private reporting, hedef response süreleri, safe harbor ve güvenlik sınırları.                               |
| [Support](SUPPORT.md)                    | Doğru yardım yolu, gerekli reproduction bilgisi ve support sınırı.                                                                 |
| [Roadmap](ROADMAP.md)                    | Güncel yön ve Pactmark’ın bilinçli olarak vaat etmediği capability’ler.                                                            |
| [Changelog](CHANGELOG.md)                | Her sürümün neyi değiştirdiği ve hangi davranışın `main`’de hâlâ yayımlanmamış olduğu.                                             |
| [İsim ve logo politikası](TRADEMARKS.md) | Endorsement veya resmîlik izlenimi vermeden adil topluluk kullanımı.                                                               |

Commit’lerde [DCO 1.1](https://developercertificate.org/) sign-off gerekir.
Gelecekteki katkılar için DCO’ya ek bir Contributor License Agreement
hazırlanmaktadır; metin hukuk incelemesi bekleyen bir taslaktır, geriye yürümez
ve bugün Apache-2.0 lisansını değiştirmez. Bağlayıcı CLA dili İngilizcedir; bu
Türkçe açıklama yalnızca bilgilendirme amaçlıdır. Code, documentation,
translation, review, triage, test design ve community care katkılarının tümü
değerlidir.

## Dokümantasyon ve örnekler

- [Dokümantasyon ana sayfası](https://pactmark-docs.lokomotif.ai/tr)
- [English documentation](https://pactmark-docs.lokomotif.ai)
- [İlk agent’ını oluştur](https://pactmark-docs.lokomotif.ai/tr/getting-started/first-agent)
- [Kavramlar ve mimari](https://pactmark-docs.lokomotif.ai/tr/concepts/architecture)
- [Tool’lar ve effect’ler](https://pactmark-docs.lokomotif.ai/tr/concepts/tools-and-effects)
- [Run yaşam döngüsü](https://pactmark-docs.lokomotif.ai/tr/concepts/run-lifecycle)

### Çalıştırılabilir örnekler

Her örnek deterministic fixture’larla çevrimdışı çalışır ve model anahtarı
istemez. Her biri kendi sınırını açıkça yazar; hiçbiri production template’i
değildir.

| Örnek                                                                  | Neyi gösterir                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [`quickstart-agent`](examples/quickstart-agent/)                       | En kısa yönetişimli agent: varsayılan local policy, bir R1 read, bir governed R2 write. Yayımlanmamış `main` facade’ini kullanır.      |
| [`minimal-tool-agent`](examples/minimal-tool-agent/)                   | Yayımlanmış 0.2.0’ın desteklediği açık kompozisyon: profiller, authority, `WorkOrder`, bütçeler, sıralı event’ler, artifact, evidence. |
| [`approval-agent`](examples/approval-agent/)                           | Gerçek bir approval sınırının arkasındaki simüle dışa dönük effect; decision challenge komut çıktısına asla girmez.                    |
| [`approval-purchase-boundary`](examples/approval-purchase-boundary/)   | Public decision ve approval komutları açık olmadığı için fail-closed davranan exact R4 satın alma preview’ı.                           |
| [`delegated-incident-boundary`](examples/delegated-incident-boundary/) | Tek run, scheduler receipt, lease ve fencing token’a bağlanmış worker delegasyonu; yeni fence eskisini geçersiz kılar.                 |
| [`evidence-document-pipeline`](examples/evidence-document-pipeline/)   | İçerik adresli doküman byte’ları, exact-byte ve citation-shape doğrulaması, claim sınırlı `EvidenceRecord` export’u.                   |
| [`portable-agent`](examples/portable-agent/)                           | Değişmeyen tek bir agent implementasyonunun Node, Vercel ve Cloudflare biçimli entrypoint’lerden çağrılması.                           |
| [`research-evidence-agent`](examples/research-evidence-agent/)         | Deterministic bir kaynak fixture’ının doğrulanmış artifact’e ve `EvidenceRecord`’a dönüştürülmesi.                                     |
| [`workspace-agent`](examples/workspace-agent/)                         | Sınırlı sanal dosya sistemi: allowlist’li kökler, path ve symlink reddi, komut/çıktı/süre limitleri, cancellation ve redaction.        |

### Host fixture’ları

- [Node quickstart](apps/node-quickstart/) — HTTP/SSE ve lifecycle davranışı.
- [Next.js/Vercel fixture](apps/nextjs-vercel/) — auth, route’lar ve UI sınırı.
- [Cloudflare Worker fixture](apps/cloudflare-worker/) — deneysel ephemeral edge
  profili ve dürüst readiness raporu.

## Lisans

Kaynak kod [Apache License 2.0](LICENSE) ile sunulur. Atıf bilgileri için
[NOTICE](NOTICE) ve [ORIGIN_AND_ATTRIBUTION.md](ORIGIN_AND_ATTRIBUTION.md)
dosyalarına bakın. Pactmark adı ve logosu ayrıca
[TRADEMARKS.md](TRADEMARKS.md) ile yönetilir; lisans modified distribution’ın
resmî Pactmark release’i gibi sunulmasına izin vermez.

---

<p align="center"><strong>İşi sınırla. Otoriteyi modelin dışında tut. Sonucu doğrula.</strong></p>
