# Pactmark: güvenlik, kullanım ve karakter suikastı

**Tarih:** 2026-08-20 (UTC)
**Hedef:** `lokomotifai/pactmark` — branch `main`, commit `795373f966100f6e2bf251ec3593367f5cd506f6`
**Yayınlanan çizgi:** `0.2.0` (19 public paket, 15 Ağustos 2026)
**Bu dosya:** bağımsız inceleme ve roast. Ürün dokümantasyonu, sertifika, CVE veya pentest raporu değildir.
**İndirme:** bu Markdown dosyasını GitHub PR’dan ham olarak indirebilirsin. Cloud ajan ortamı senin bilgisayarındaki `Downloads` klasörüne yazamaz.

---

## 0. Önce cümle

Pactmark, ajan çerçevesi değil. **Bir otorite işletim sistemi** — ve henüz kullanıcısı yok.

On beş günde (GitHub’da 5 Ağustos → 15 Ağustos) 19 paket, OIDC trusted publishing, SLSA provenance, CycloneDX SBOM, 19 maddelik threat model, fail-closed policy, opaque credential, tenant’lı Postgres, MCP pin, fuzz, CodeQL, Scorecard ve “verified release” rozeti çıkarmışsınız. Yıldız sayısı: **1**. Fork: **0**. Açık issue: **0**. Katkı geçmişi: bir insan ve onun asistanları.

Bu, güvenlik tiyatrosu değil. Daha acımasız bir şey: **kullanılmayan bir nükleer reaktörün işletme el kitabı.** Kontrol çubukları gerçek. Yakıt yok. Şehir boş.

Bu inceleme kasıtlı olarak iki şeyi aynı anda yapıyor:

1. Çekirdekte klasik “RCE buldum, `eval` açık” avı değil; **host entegrasyonunun güvenlik olduğu** gerçeğini merkeze almak.
2. Ürünü, DX’i, jargonu ve “60 saniyede başla” yalanını **acımasızca** pişirmek.

Spoiler: kernel, bu sınıfın gördüğü en dürüst fail-closed tasarımlardan biri. Ürün ise kendi kelime dağarcığında boğulmuş bir laboratuvar.

---

## 1. Kapsam ve yöntem

Kaynak tarandı, doküman ezberlenmedi:

| Katman | Bakılan yer |
| --- | --- |
| Çekirdek | `packages/core`, `runtime`, `policy`, `evidence` |
| Host / protokol | `http`, `mcp`, `cli`, `node`, `vercel`, `cloudflare` |
| Saklama | `store-postgres`, `store-memory`, `driver-postgres-worker` |
| Yürütme | `executor-in-process`, `executor-sh`, sandbox fixture |
| DX | `@pactmark/agent`, `create-pactmark`, `ai-sdk`, `examples/*`, `apps/*` |
| Kanıt | `docs/security/*`, `docs/adr/*`, `docs/releases/v0.2-readiness.md`, README |

**Yapılmayanlar (dürüst sınır):** canlı pentest yok, `pnpm verify` bu incelemede koşturulmadı, özel `pactmark-documentation` reposuna girilmedi, üretim cluster’ı yok. Bu bir **statik, kod-kanıtlı** inceleme. Yeşil CI, “açık yok” demez; bu rapor da “sömürülebilir 0-day” uydurmaz.

---

## 2. İnfaz özeti (yönetici için)

| Soru | Cevap |
| --- | --- |
| Çekirdek default-deny gerçek mi? | **Evet.** `evaluatePolicyPreflight` belirsizlikte deny eder. |
| Model otorite mi? | **Hayır.** Tool call yeniden çözülür; grant/approval/credential host’tadır. |
| Üretimde güvenli misiniz? | **Hayır, ve siz de öyle diyorsunuz.** Sandbox status: `unsafe reference fixture`. |
| Asıl güvenlik sınırı nerede? | Host’un `authenticate` / `authorize` / `set_config` / sandbox / egress / grant genişliği. |
| Kernel’de ucuz RCE / `any` / skip test var mı? | **Görünmedi.** `TODO`/`FIXME`/`as any`/`it.skip` paket kaynaklarında yok. |
| İnsan 60 saniyede ajan mı yazar? | **Hayır.** 0.2.0 yolu ~220 satır; 30 satırlık facade `Unreleased`. |
| Bu bir ürün mü, bir tez mi? | Tez. Çok iyi yazılmış, yayınlanmış, yıldızlanmamış bir tez. |

**En tehlikeli cümle README’de değil, ADR-0001’de:**

> Hosts retain responsibilities that an open-source library cannot satisfy, including identity, tenant isolation, secret custody, network enforcement, retention, deployment, and incident response.

Çeviri: **güvenlik sizin problemine, entegrasyon bizim disclaimer’sına.** Bu doğru bir mühendislik duruşu. Aynı zamanda ürün vaadinin iskeletini boşaltır. Pactmark’ı “güvenli ajan framework’ü” diye satın alan herkes, aslında bir **port fabrikası** ve bir **yemin metni** satın alır.

---

## 3. Karakter roast’ı: bu repo bir kişilik bozukluğudur

### 3.1 NASA tedarik zinciri, bir kişilik hayran kitlesi

Repo 2026-08-05’te doğmuş. On gün sonra `v0.2.0` “verified public package release.” Immutable GitHub Release, 26 asset, anonymous tarball verification, npm OIDC, Scorecard.

GitHub istatistikleri (2026-08-20):

- stars: **1**
- forks: **0**
- open issues: **0**

`CONTRIBUTING.md` good-first-issue ve help-wanted etiketlerine işaret ediyor. Etiketlenecek issue yok. `docs/community/` bir şehir planı; şehir yok.

Bu, “erken aşama” değil. Bu, **seyircisiz opera.** Sahne, orkestra, yangın merdiveni, deprem yönetmeliği, even a leaked-secret drill dated 2026-08-03 — public repo’dan iki gün önce. Masabaşı kriz tatbikatınız, ürünün GitHub kimliğinden yaşlı.

### 3.2 Model asla otorite değildir — ta ki `git shortlog`’a bakana kadar

```
46  Komünite — Asistan
26  Fatih Guner
 2  dependabot[bot]
```

Tez: model yetki kullanamaz. Tarihçe: model first author. Bu bir güvenlik açığı değil. Bu bir **estetik kaza.** “The model is never the authority” cümlesini 46 asistan commit’inin üstüne yazmak, “sigara içilmez” tabelasını kül tablasının üzerine asmaya benzer: doğru, ve komik.

### 3.3 Disclaimer-as-a-service

Her ciddi dosya aynı liturgiyi tekrarlıyor:

- exactly-once değil
- fully secure değil
- certified değil
- production-isolated değil
- sandbox değil, `unsafe_local`
- yeşil test sadece o fixture’ı kanıtlar

Bu **dürüstlük.** Aynı zamanda ürünün tek tutarlı UX’i: **kaçınma.** README rozet sırası CI / npm / verified release. Threat model TM-18 tam da bunu öngörüyor: doğrulama, sertifika gibi pazarlanır. Siz pazarlamıyorsunuz; **rozetleri yan yana koyup “ama aslında değil” dipnotu düşüyorsunuz.** İnsan beyni dipnot okumaz. Rozet okur.

En dürüst cümle sandbox dokümanında, README kahramanında değil:

> Status: **unsafe reference fixture**.

Bunu README’nin ilk ekranına koysanız ürün daha az sevimli, daha çok yetişkin olurdu.

### 3.4 Jargon kola borusu

Bir “hello catalog” için tüketici şunları yutmak zorunda:

`WorkOrder`, `workMode`, `autonomyMode`, `dataClass`, `DecisionChallenge`, `AuthorizationReservation`, `CapabilityGrant`, `SecretRef`, `ModelCredentialRef`, `EgressBroker`, `EvidenceRecord`, `RuntimeCapabilities` (~20 alan), risk `R0`–`R5`, ve **200’den fazla** `KAF_*` kodu.

Hata mesajı İngilizce cümle değil, makine kodu. AGENTS sözleşmesi: tüketiciler İngilizce mesaj parse etmesin. Güzel. Sonuç: ilk saat insanı `KAF_RUNTIME_NOT_READY` ile konuşmayı öğrenir, ajan yazmayı değil.

`@pactmark/core` API raporu **7574 satır / 388 export.** `@pactmark/agent` facade **448 satır / ~48 export.** İki ürün yapıştırılmış: biri domain anayasası, biri “lütfen bizi kullanın” notu.

### 3.5 “60 saniye” bir reklam suçu, güvenlik suçu değil

README:

```sh
npm create pactmark@latest -- my-agent
cd my-agent
npm run dev
```

Aynı README, 30 satırlık ajanın **Unreleased** olduğunu itiraf ediyor. Yayınlanan 0.2.0 yolu: `examples/minimal-tool-agent/src/example.ts` — **220 satır**, bir katalog lookup için.

Bunu **siz yazmışsınız.** `docs/plans/2026-08-15-provider-tool-loop-and-facade-dx.md`:

> The facade's minimum viable agent costs ~220 mandatory lines.

Sonra `packages/create-pactmark/README.md` hâlâ diyor ki:

> The public `npm create pactmark@latest` command remains planned until package ownership and an authorized registry release are verified.

Komut npm’de **0.2.0 olarak duruyor.** Kök README satıyor. Paket README “planned.” Üç belge, üç gerçeklik. Supply-chain’iniz byte-identical tarball doğruluyor; dokümanlarınız aynı cümlede anlaşamıyor.

`apps/node-quickstart`: `/readyz` **bilerek 503.** Bu olgun. Bu aynı zamanda “quickstart” kelimesine hakaret.

`createLocalRuntime({ agents })` iki argüman gibi duruyor. Uygulama: `packages/agent/src/runtime.ts` **1157 satır** gizli kablolama. Sihir değil, **mobilyayı halının altına süpürmek.**

### 3.6 `pnpm verify` bir kapı değil, bir din

Kök `package.json`: **90 script.** `verify` → `verify:release` → **34** `&&` adımı. `security:verify` içeride 18 adım daha. Workspace: 20 paket, 9 example, 3 app, ~36k satır paket kaynağı, `runtime.ts` tek başına **5209 satır.**

Katkı yolu: DCO, Changeset, packed-consumer kanıtı, naming freeze, knip, license audit, secret audit, workflow audit. Bu bir açık kaynak daveti değil. Bu bir **temiz oda protokolü.** Temiz oda boşsa protokol kendini yemeğe başlar.

Roadmap’in “Intentionally not promised” listesi dürüst: chat SDK yok, no-code yok, hosted control plane yok, production sandbox yok. Yani ürün vaadi: **siz host olun, biz kernel olalım.** Host olmak isteyen insan sayısı, kernel yazan insan sayısından az. Siz ikinci grubun tamamısınız.

### 3.7 Türkçe: parity vaadi, off-repo gerçek

Kullanıcı bu roast’u Türkçe istedi. Repo’da Türkçe ürün rehberi yok. `README.tr.md` var. Asıl rehber: `https://pactmark-docs.lokomotif.ai/tr`, kaynağı **private** `lokomotifai/pactmark-documentation`.

Open-source kernel, kapalı how-to. İngilizce/Türkçe parity roadmap’te “Now.” In-tree gerçek: ayna README. API adları İngilizce kalmalı — doğru. Ama `KAF_*` kodunun remediation URL’si (aşağıda) ölü bir domaine gidiyorsa, Türkçe rehberin private oluşu ikinci sıraya düşer: **insan zaten hata sayfasını açamıyor.**

---

## 4. Güvenlik: ne gerçekten tutuluyor

Roast etmek, yalan uydurmayı gerektirmez. Şunlar **kodda var** ve ciddi:

### 4.1 Policy fail-closed (çekirdek)

`packages/policy/src/policy.ts` — `evaluatePolicyPreflight`:

- parse hatası → `KAF_POLICY_INVALID_INPUT`
- bilinmeyen purpose / data class / risk matrisi → deny
- şema doğrulanmamışsa → `KAF_POLICY_SCHEMA_REQUIRED`
- boş scope, tavan aşımı, bütçe, network enforcement → deny
- default config id: `pactmark.default-deny`, `defaultDecision: "deny"`

Bu, “system prompt’ta söyleme” değil. Belirsizlik **allow değil.**

### 4.2 Credential opacity

`SecretRef` / `ModelCredentialRef` metadata. `ResolvedToolCredential` değeri `#value` private; `toJSON` / `toString` → `KAF_CREDENTIAL_SERIALIZATION_FORBIDDEN`. Runtime model credential’ı mühürlüyor, `resolveCredential()` bir kez. Canary testleri event/error sızmasını arıyor.

Bu, ajan ekosisteminde **nadir ve doğru.**

### 4.3 HTTP kenarı

`packages/http/src/handler.ts`:

- `authenticate` yoksa constructor patlar (anonim dev hariç)
- problem+json: `code` / `status` / `retryable` / `requestId` — stack yok, `details` yok
- `Cache-Control: no-store`, CSP `default-src 'none'`, `X-Frame-Options: DENY`
- cookie CSRF: origin allowlist + `Sec-Fetch-Site` + constant-time karşılaştırma
- artifact/evidence için `concealResource` → 404 (enumeration’a karşı)

### 4.4 MCP: discovery düşman

Pin’li transport, host’un `safeDescription`’ı, şema digest drift → `KAF_MCP_TOOL_SCHEMA_DRIFT`, stdio `shell: false`, production stdio için sandbox şart, düz `fetch` preview-only, redirect deny, ambient auth header strip.

### 4.5 Effect / approval replay

Grant `reserveUse`, authorization reservation aynı key’de exact replay, Postgres UoW içinde grant + approval claim + reservation + effect **aynı transaction.** Uncertain effect otomatik retry değil, park / reconcile. Exactly-once iddia **yok** — doğru.

### 4.6 Initializer

`create-pactmark`: relative path, `..` yok, `wx` (overwrite yok), symlink parent reddi, `--ignore-scripts`. Traversal/overwrite tarafı olgun.

### 4.7 Supply chain

Pin’li lockfile, lifecycle deny, immutable actions, long-lived npm token yok, anonymous registry byte check. v0.2.0 için bu, yaşınızın çok üstünde.

**Sonuç:** “güvenlik tiyatrosu” demek tembel olur. Tiyatro, boş kontrol demektir. Sizde kontroller **dolu** — ama sahne ışığı host’un üzerine düşmüyor, sizin disclaimer’ınıza düşüyor.

---

## 5. Asıl açıklar ve residual risk

Buradaki “açık” kelimesi çoğu yerde **CVE değil, fail-closed sözleşmesinin host’ta unutulması.** Yine de birkaç tanesi kod-seviyesi ayak izi bırakıyor.

### 5.1 Kritik sınıf: “framework güvende, sen değilsin”

#### H-01 — HTTP tenant izolasyonu = host `authorize` kalitesi

**Severity:** High (entegrasyon) / Critical (yanlış host)
**Kanıt:** `packages/http` JWT→tenant bağamaz. `AuthenticatedRequest.authority` host’tan gelir.

Framework cross-tenant SQL yazmıyor. Framework, sen `tenantId: "acme"` derken `"globex"` geçirirsen **sana inanır.** Confused deputy (TM-04) burada ölmez; **host mapping’te** yaşar.

Roast: çok-tenant güvenlik broşürü basmışsınız. Broşürün arkasında “kimlik sizin işiniz” yazıyor. Bu bir ürün özelliği değil, **sorumluluk ihracı.**

#### H-02 — RLS “var”, session GUC yok

**Severity:** High
**Kanıt:** Migration `011` `pactmark.tenant_id` RLS politikası. Paket kaynaklarında **`set_config('pactmark.tenant_id', …)` çağrısı yok.** README: host aynı transaction içinde set etmeli. Unset → hiçbir satır (fail-closed **eğer** non-owner role ise). Table owner RLS’i bypass eder. Profil hâlâ `tenantIsolation: "database_constraint"` reklam eder.

SQL `WHERE tenant_id = $1` asıl savunma. RLS, host GUC yazmazsa **kostüm.** Kostümlü fail-closed, fail-closed değildir; **dokümante edilmiş dual-control**’dür ve dual-control’ün bir kolu kodda yok.

#### H-03 — `allowedTenants` default `["*"]`

**Severity:** High (ayak tuzağı)
**Kanıt:** `packages/store-postgres/src/config.ts`

```ts
allowedTenants: [...(options.allowedTenants ?? ["*"])],
allowedPurposes: [...(options.allowedPurposes ?? ["*"])],
```

`PostgresStorageGuard` `*` görünce her tenant’ı kabul eder. Default-deny kilisenin durable store vaftizi **default-allow.** “Yıldız her şeyi açar” bir escape hatch; escape hatch default ise kapı değil, hol.

`highly_restricted` yazmayı reddetmeniz güzel. `*` ile her tenant’ı kabul etmeniz o güzelliği yer.

#### H-04 — `createPolicyEngine` tam yetki değildir, adı yetki gibi durur

**Severity:** High (ayak tuzağı)
**Kanıt:** `packages/policy/src/policy.ts`

```ts
/** Preliminary core port adapter. It never dispatches and deliberately cannot
 *  turn its result into authority; runtime still resolves and reserves a grant. */
export function createPolicyEngine(...)
```

Engine **sadece preflight** çalıştırır. Grant yokluğu burada deny etmez. Sonuç `allow_with_grant` olabilir — **grant olmadan.**

İsim: `allow_with_grant`. Semantik: “grant getirirsen belki.” Runtime doğru kullanıyor (`packages/runtime/src/runtime.ts` grant reserve eder). Facade dışı tüketiciler, test double’lar, “policy allow dedi” log’u — klasik **kesme tuzaklı API.** Policy README uyarıyor. Uyarı, ismin yerini tutmaz.

Adversarial testiniz bile bunu biliyor:

```ts
if (decision.decision === "allow_with_grant") dispatch();
expect(decision.decision).not.toBe("allow_with_grant");
```

Yani kendi testiniz “bu string’i görünce insanlar dispatch eder” varsayıyor. Doğru varsayım. Kötü isim.

#### H-05 — Kill switch: şema geniş, kablo ince

**Severity:** Medium–High
**Kanıt:** `KillSwitchTargetKindSchema` şunları tanır: `tool_registration`, `mcp_server`, `model_adapter`, `model_profile`, `policy_registration`, `compensation_definition`, `compensation_strategy`.

`evaluatePolicyPreflight` yalnızca şunlara bakar:

```ts
killSwitches?.isKilled("tool_registration", ...) === true ||
killSwitches?.isKilled("policy_registration", ...) === true
```

Zehirli bir MCP sunucusunu `mcp_server` kind ile öldürmek, **preflight’ın umrunda değil.** Registry duruyor. Panic button’ın kablosu prize takılı değil. Durable dağıtım da host’un “persist the snapshot” cümlesine bırakılmış — in-process map.

Incident playbook’unuz var. Kill switch’iniz var. İkisinin birleştiği yerde **MCP kind ölü kod.**

#### H-06 — `pactmark_secret_refs`: şema hayalet

**Severity:** Medium–High (üretim profili)
**Kanıt:** tablo migration `001` / `migrations.ts` içinde. `store-postgres/src` altında **SecretRefStore implementasyonu yok.** Durable secret metadata için TypeScript kapısı memory policy boundary + `DenyAllSecretRefStore`.

Postgres’e bir mezar kazmışsınız. Cesedi memory’de tutuyorsunuz. Çok-process worker + secret ref = **her process kendi kafasındaki kasa.** Durable claim’iniz secret lifecycle’ı kapsamıyor; tablo yalan söylemiyor, **eksik söylüyor.**

#### H-07 — `networkPolicy: "declared"` ≠ enforced; varsayılan executor `unsafe_local`

**Severity:** High (yanlış reklam / yanlış üretim)
**Kanıt:** in-process ve executor-sh `sandbox: "unsafe_local"`, en fazla `declared`. Policy `"enforced"` isteyebilir; bu executor’lar onu **ilan etmez.** Sandbox dokümanı: üretim arbitrary-code için ayrı, bağımsız değerlendirilmiş izolasyon şart.

İnsanlar `npm create` → in-process → “Pactmark güvenli” diye production’a koyacak. Siz `console.warn` ve capability snapshot ile kendinizi kurtardınız. **Kurtarmadınız.** Capability JSON’u okunmaz. README 60 saniye okunur.

`@pactmark/executor-sh` public release’te bile değil (`0.1.0`, private workspace). Yani “daha az kötü” yürütücü **npm’de yok.** Public yol: process içi callback. Isolation marketing’i, teslim edilmeyen bir paket.

---

### 5.2 Yüksek sınıf: enjeksiyon, sızma, operasyon

#### H-08 — Prompt injection çözülmedi; yetki sınırı daraltıldı

TM-01 / TM-02 sizin metniniz. Model yasak tool isteyebilir; policy keser. **İzinli tool’un içinde** hedef saptırma, data exfil via allowed egress, semantic hijack — host grant’i genişse yaşar.

Runtime model context’i pratikte:

```ts
{ goal, input, toolResult }
```

Son tool sonucu. Çok-adımlı zehir biriktirmez (iyi). Çok-adımlı yararlı bağlam da tutmaz (ürün). Indirect injection **admitted data** içinde durur. “Model never authority” prompt injection’ı öldürmez; **yetkisiz effect’i** öldürür. İkisi farklı hasta.

#### H-09 — Redaksiyon: typed path + regex emniyet filesi

`packages/evidence/src/redaction.ts` yorumu: regex **secondary safety net.** Bearer/JWT/api key yakalar. `Authorization: Basic`, özel header, YAML, URL query, provider-specific token şekilleri — regex’in hayal gücü kadar.

Typed rule yazmayan host, “Pactmark redakte eder” sanır. Etmez. **Kaçırır.**

#### H-10 — Anonim HTTP: uyarı + header, ağ politikası değil

`allowAnonymousDevelopment` yalnızca `ephemeral`. `/readyz` fail. `X-Pactmark-Development-Mode: anonymous`. `console.warn`.

Bu, reverse proxy arkasında unutulan “geçici” handler’lar için klasik. Header bir kontrol değil, **itiraf.** Network policy header okumaz.

#### H-11 — Hata dokümantasyon domain’i ölü: `pactmark.dev`

**Severity:** Medium (güvenlik UX / yönlendirme)
**Kanıt:** HTTP default `documentationBaseUrl = "https://pactmark.dev/errors"`. CLI `docsUrl` aynı host.

2026-08-20’de `https://pactmark.dev/errors` bu ortamdan **500 / yanıt vermeme.** Asıl doküman sitesi `pactmark-docs.lokomotif.ai` **200.**

Problem+json `type` alanı RFC 7807’de insanların tıklayacağı URL. Tıklanınca ölü site. 200+ `KAF_*` kodunuz var; rehberiniz yanlış şehirde. “Consumers never parse English messages” — o zaman **URL çalışmak zorunda.** Çalışmıyor.

`pactmark-docs.lokomotif.ai` yanıtında `access-control-allow-origin: *` var. Doküman sitesi için düşük risk; “her header’ı sıkı tutuyoruz” iddiasıyla uyumsuz bir gevşeklik.

#### H-12 — Şifre / yedek / key: host, yine

Event JSONB application-encrypt değil. Confidential body için `DataProtector` şart; `Aes256GcmDataProtector` + nonce registry referans. Yedek, volume encryption, key custody, restore drill — paket iddia etmiyor.

Doğru. Residual: **DB superuser, operatör hatası, yedeksiz disk** TM-07/TM-17’nin gerçek dünyası. Framework bunu kapatamam. Pazarlama kapatmış gibi durmamalı.

#### H-13 — MCP / stdio production = senin sandbox’ın kalitesi

Kod dürüst: production stdio injected sandbox ister. macOS inode recheck yorumu pathname race’i **elemiyor**, preview-only diyor.

Pactmark “MCP’yi sandboxed yaptı” iddiası **yapamaz.** Adapter, sandbox’ın varlığını **sorar.** Cevap kötüyse sınır kötü.

#### H-14 — Bellek içi grant / secret / kill-switch

Policy README: memory implementasyonlar process-local, durability ilan etmez. Postgres UoW grant/approval için var; secret ve kill-switch durable dağıtımı yok.

Çok-instance worker’da in-process kill switch: **bir kutuyu öldürürsünüz, diğeri çalışır.**

#### H-15 — AI SDK pin ve “gerçek model döngüsü”

`AI_SDK_TESTED_RANGE = ">=7.0.48 <8"`. Dışarıdaki sürüm → `KAF_MODEL_ADAPTER_MISMATCH`. Sıkı ve kırılgan. 0.2.0 planı: gerçek provider’ın tool advertise etmediğini **kabul ediyordu.** `main` üzerinde facade/tool loop işi var; yayınlanan çizgi ile `main` arasında “hangi dünyadasın” sorusu bir güvenlik sorusu değil, **yanlış sürümle yanlış güvenlik varsayımı** sorusu.

---

### 5.3 Orta / düşük: sürtünme, sapma, yalan- palet

| ID | Konu | Neden önemli |
| --- | --- | --- |
| M-01 | `create-pactmark` README vs npm gerçeği | Operatör yanlış kurulum yoluna sapar |
| M-02 | Ürün dokümanı private repo | Public kernel, private kılavuz; review ve fork zayıf |
| M-03 | `doctor:production` kasıtlı fail (Next fixture) | İyi — insanlar yine Preview’ı “yeter” sanır |
| M-04 | Cloudflare experimental | Adapter yüzeyi, üretim iddiası değil; isim durur |
| M-05 | Son tool sonucu context | Injection yüzeyi küçük, ajan zekâsı da küçük |
| M-06 | 34 adımlı verify | Katkı maliyeti; yorgun reviewer = kaçan diff |
| M-07 | Destek: no SLA, deployment operate etmeyiz | Doğru; “güvenli framework” alıcısı bunu geç okur |
| M-08 | `0.1.x` security-fix yok | Eski tarball’lar açık mezarlığı; upgrade baskısı iyi, iletişim şart |
| L-01 | 1 star / 0 issue | Tehdit istihbaratı yok; “kimse kırmadı” ≠ “kırılamaz” |

---

## 6. Kullanım riskleri (güvenlikten ayrı, daha ölümcül)

Güvenlik açığı sizi haber yapar. Kullanılamama sizi **yok** eder.

1. **İlk ajan maliyeti.** 0.2.0’da bir read-tool ajan ~220 satır zorunlu tören. Facade 30 satır `main`’de. Tüketici npm’den 0.2.0 çeker, README’den 30 satır bekler, 20 field’lık `RuntimeCapabilities` ile tanışır.

2. **Port çiftliği.** `packages/core/src/ports.ts` içinde ~30 `export interface`: Clock, IdGenerator, EventStore, ContextStore, ArtifactStore, Evidence/Verification/Pattern store, DataProtector, RunLeaseStore, ModelDriver, ToolExecutor, EgressBroker, PolicyEngine, WakeupScheduler, SandboxAdapter, … Ephemeral demo gizler. Production `createRuntime` gizlemez.

3. **WorkOrder bir form, bir cümle değil.** goal + input yetmez; purpose, dataClass, retention, workMode, autonomyMode, decisionOwner, capabilities, resourceScopeCeiling, budget. Chat SDK bekleyen insan burada ölür. Siz chat SDK olmak istemiyorsunuz. O insan da sizin müşteriniz olmayacak. Peki kim kalıyor? **Zaten otorite kernel’i yazabilecek ekipler.** Onlar da kendi kernel’lerini yazıyor.

4. **Hazır değilken hazır görünmek.** `/readyz` 503 dürüst. `npm run dev` yeşil bir katalog lookup. İkisi aynı ürünün zıt ucları. Satış slaytı ikinciyi, postmortem ilki gösterir.

5. **Örnekler yalan söylemeden ağır.** `minimal-tool-agent` minimal değil. `approval-agent` facade değil, özel harness. `nextjs-vercel` demo banner’lı fixture; `doctor:production` fail. İsimlendirme: “minimal”, “quickstart”, “example” — hepsi **öğretici yemin**, hiçbiri ürün.

6. **Hata UX’i düşmanca.** `KAF_POLICY_NETWORK_ENFORCEMENT_REQUIRED` güzel bir kod. Yanında ölü `pactmark.dev` linki. Yeni kullanıcı debugging değil, **teoloji** yapar.

7. **Toolchain kelepçesi.** Node `^22.14 \|\| ^24`, pnpm **tam** `11.18.0`. Bu tekrarlanabilirlik. Bu aynı zamanda “neden `npm i` çalışmıyor” blog yazısı.

8. **Ekosistem yok.** Adapter’lar sizin. Hosted control plane yok. Billing yok. Multi-user identity yok. UI bir fixture. SUPPORT.md: custom agent design / production incident command kapsam dışı. Framework, **bitmiş bir şirket varsayıyor.** Şirket bu repo.

---

## 7. Tehdit modele karşı dürüst skor kartı

Sizin TM tablonuz zaten acımasız. Benim işim onu **pazarlama cümlesine çevirmemek**, kodla hizalamak.

| ID | Sizin severity | Kod hizası | Residual (bu inceleme) |
| --- | --- | --- | --- |
| TM-01/02 injection | critical | Yetki kesilir, semantik hijack kalır | Geniş grant = geniş hasar |
| TM-03 tool drift | critical | Registration digest gerçek | Kötü tool, ilan ettiği scope’ta serbest |
| TM-04 confused deputy | critical | Binding’ler var | Host identity mapping |
| TM-05 approval replay | critical | Atomic consume var | İnsan preview’ı yanlış anlar |
| TM-06 secret exfil | critical | Opaque ref gerçek | Process memory / provider / host log |
| TM-07 cross-tenant | critical | SQL tenantId + (uyuyan) RLS | `*` default, owner bypass, GUC yok |
| TM-08 uncertain retry | critical | Park/reconcile var | Exactly-once yok (ilan da yok) |
| TM-09 path traversal | high | Canonicalization var | Kernel/FS gerçekliği host |
| TM-10 SSRF | high | URL policy var | DNS rebind / declared≠enforced |
| TM-11 budget | high | Reservations var | Estimator / fiyat sapması |
| TM-12 lease | high | Postgres fencing var | DB failover |
| TM-13 sandbox escape | critical | Fixture **unsafe** | Production isolation yok |
| TM-14 malicious MCP | high | Pin + bounds var | Kill `mcp_server` kablosuz; sandbox host |
| TM-15/16 supply chain | critical | 0.2.0 kanıtı güçlü | Maintainer hesap / npm / upstream |
| TM-17 telemetry leak | high | Default off / metadata | Host exporter |
| TM-18 evidence misuse | high | Dil sınırlı | Rozet sırası hâlâ ayartıyor |
| TM-19 Executor | critical | Private, pin’li, generic `execute` model-visible değil | Deployment / kernel / QuickJS sınırı |

Sizin threat model’iniz, benim roast’umdan **daha sert.** Bu nadir. Pazarlama yüzeyiniz threat model’inizden yumuşak. Asıl reputasyon riski burada: **en iyi belgeniz en az okunan belgeniz.**

---

## 8. Adil paragraf (roast’un yemin tazminatı)

Aşağıdakiler övgü, değil **itiraf:** bu çekirdeği “LangChain ama Zod’lu” diye geçiştirmek aptallık olur.

- Model-asla-otorite kuralı slogan değil, dispatch yoluna işlemiş.
- Credential’ların `toJSON`’da patlaması, “log’a koyma” checklist’inden üstün.
- Effect ledger + uncertain park, ajan framework’lerinin en sık yalandığı yerde (retry) dürüst.
- Packed-consumer / tarball kabulü, workspace-link yalanını reddediyor.
- Test kültürü: skip yok, `any` yok, adversarial policy testleri var.
- v0.2.0 yayın kanıtı, yaşına göre aşırı.

Yani: **mühendislik gurur duyulacak kadar katı; ürün, o katılığı taşıyamayacak kadar ağır; güvenlik, host’un ödevine o kadar bağlı ki “Pactmark güvenli” cümlesi neredeyse anlamsız.**

Anlamsız, çünkü doğru cümle şu:

> Pactmark, host doğru yaptığı sürece fail-closed kalmaya **yardımcı** olan bir kernel’dir. Host yanlışsa Pactmark, yanlışlığı **daha düzenli kanıtlar.**

Düzenli kanıt, güvenlik değildir. Güzel bir postmortem’dir.

---

## 9. Öncelikli düzeltmeler (roast bitti, iş listesi)

Sıra, “yeni ADR yazın” değil. Sıra, **ayağa basılan yerler.**

1. **`pactmark.dev` hata URL’lerini canlı kanonik dokümana bağla** veya default’u `pactmark-docs.lokomotif.ai` yap. Ölü `type` URL, RFC 7807 tiyatrosu.
2. **`create-pactmark` README “planned” yalanını öldür.** Tek gerçeklik: npm’de 0.2.0 var; 30 satır Unreleased.
3. **`createPolicyEngine` adını veya dönüşünü değiştir.** `allow_with_grant` grant yokken çıkmasın; ya `preflight_pass` de, ya grant yoksa deny.
4. **Kill switch preflight’a `mcp_server` / `model_*` kind’larını bağla** veya şemadan sil. Ölü kind, sahte incident kapasitesi.
5. **Postgres adapter’da `set_config('pactmark.tenant_id')`’i transaction helper’a göm.** README’ye bırakma. Owner/non-owner rol ayrımını “attestation opsiyonel” değil, production profilinin **şartı** yap.
6. **`allowedTenants` default `["*"]` kalksın.** Production profili explicit liste istesin.
7. **`pactmark_secret_refs` için gerçek `SecretRefStore` veya tabloyu “unused” diye işaretle.** Hayalet tablo, hayalet kasa.
8. **README kahramanı: 0.2.0 yolu 220 satır / ephemeral / `unsafe_local`.** 60 saniye kalsın ama yalan söylemesin.
9. **Public in-tree getting-started.** Private docs sitesi katkı ve denetimi öldürür.
10. **Issue açın.** 0 open issue, 0 fork, “community” klasörü — bu bir güvenlik sinyali: **dış göz yok.** Threat model’iniz maintainer account compromise’i medium’a koymuş. Dış göz olmayan projede maintainer account tek saldırı yüzeyi değil, **tek yüzey.**

Bunların hiçbiri sizi “certified” yapmaz. Sizi, kendi threat model’inizle **daha az çelişir** hale getirir.

---

## 10. Kapanış roast’ı

Pactmark, ajanların “model bir şey söyledi” diye production’a yazmasını haklı olarak küçümsüyor. Sonra kendi README’sinde “60 saniye” diyor. İkisi de sizin metniniz.

Siz LangChain’i ciddiye almadınız; LangChain sizi **fark etmedi.**

Siz evidence-native bounded work inşa ettiniz. EvidenceRecord’unuzun kanıtlayacağı ilk iş büyük ihtimalle **kendi CI’ınız.**

Siz default-deny yaptınız. Sonra Postgres guard’da `*` default’u bıraktınız. İlahiyat temiz, vaftiz gevşek.

Siz “the model is never the authority” yazdınız. `git shortlog` modelin 46, insanın 26 olduğunu gösteriyor. Anayasa güzel. Nüfus sayımı değil.

Ve en acımasız cümle, ben uydurmuyorum, **siz yazmışsınız** — `docs/security/security-model.md` sonu:

> This design reduces risk but does not establish complete security, production isolation, compliance, or certification.

Bunu ürünün ön yüzüne koyun. Roast biter. Mühendislik kalır. Kullanıcı — eğer bir gün gelirse — en azından **kime ödevin düştüğünü** bilir: size değil, **host’a.** Yani ona.

O gün gelene kadar Pactmark, dünyanın en iyi belgelenmiş, en az kullanılmış, en dürüst biçimde güvensiz (çünkü izolasyon iddia etmeyen) ajan kernel’idir.

Bu bir hakaret değil. Bu, sizin kendi kanıt standardınızın **uygulanmış hali.**

---

## Ek A — tarama kanıtı (kısa)

| Metrik | Değer |
| --- | --- |
| İncelenen commit | `795373f966100f6e2bf251ec3593367f5cd506f6` |
| Public paket (0.2.0) | 18 `@pactmark/*` + `create-pactmark` |
| Private | `@pactmark/executor-sh@0.1.0` |
| `packages/core/etc/core.api.md` | 7574 satır |
| `packages/runtime/src/runtime.ts` | 5209 satır |
| `packages/agent/src/runtime.ts` | 1157 satır |
| Benzersiz `KAF_*` (paket TS, test hariç) | 200+ |
| Kök npm script | 90 |
| `pnpm verify` zinciri | 34 adım |
| GitHub (2026-08-20) | 1 star, 0 fork, 0 open issue |
| Repo oluşturulma | 2026-08-05 |
| v0.2.0 yayın | 2026-08-15 |

## Ek B — bu dosya ne değildir

- CVE talebi değildir.
- “Pactmark’ı kullanmayın” tavsiyesi değildir. **Host ödevini yapamıyorsanız kullanmayın** tavsiyesidir; bunu da siz söylüyorsunuz.
- Private documentation reposunun içeriğinin incelemesi değildir.
- `pnpm verify` yeşil/kırmızı kanıtı değildir.

İndirmek için bu dosyanın ham URL’sini kullan: repo içi yol

`docs/reviews/2026-08-20-guvenlik-ve-kullanim-roast.md`
