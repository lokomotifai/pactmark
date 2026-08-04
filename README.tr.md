# Pactmark

Pactmark, açık yetki altında sınırlandırılmış işler yapan agent’lar için kanıt-yerel bir TypeScript framework’üdür. Her çalışma doğrulanmış bir WorkOrder ile başlar, kontrollü araç etkilerini append-only event geçmişi olarak kaydeder, içerik adresli artifact’ler üretir ve yalnızca tanımlı doğrulamalar tamamlandığında başarıyla sonuçlanır.

Depo, 0.1.0 sürümüne doğru aktif geliştirme aşamasındadır. Henüz npm paketi yayımlandığı veya canlı deployment yapıldığı iddia edilmez. Public kurulum komutu ancak [PLAN.md](./PLAN.md) içindeki release kapıları geçtikten, yetkili yayın yapıldıktan ve registry sonucu doğrulandıktan sonra “doğrulandı” olarak işaretlenecektir.

## Ürün sınırı

Pactmark genel amaçlı bir sohbet SDK’sı, no-code oluşturucu, swarm orkestratörü veya production arbitrary-code sandbox değildir. Çekirdek; iş sözleşmelerini, yetkiyi, dayanıklı çalışma semantiğini, kontrollü etkileri, artifact’leri, doğrulamayı ve sınırları açık kanıt kayıtlarını sahiplenir. Model, protokol, depolama ve platform entegrasyonları adaptörlerde kalır.

Temel güvenlik kuralı şudur: model bir eylem önerebilir, fakat o eyleme izin veren otorite hiçbir zaman model değildir.

## Yerel depo kurulumu

Geliştirme Node.js 24 üzerinde yapılır; Node.js 22 ve 24 desteklenir. Monorepo pnpm kullanır.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

İlk bootstrap sırasında komutlar, ilgili work package hayata geçirildikçe kullanılabilir olur. Güncel contributor akışı için [CONTRIBUTING.md](./CONTRIBUTING.md), yürütülebilir kilometre taşları ve release kapıları için [PLAN.md](./PLAN.md) kullanılmalıdır.

## Mimari

```text
WorkOrder
  -> sınırlandırılmış agent çalışması
  -> kontrollü araç etkileri
  -> artifact
  -> verification
  -> EvidenceRecord
```

Çalışmanın doğruluk kaynağı append-only event geçmişidir; projection’lar yeniden üretilebilir. Dayanıklı production profili Postgres kullanır ve bir HTTP isteğinin, function belleğinin veya yerel dosya sisteminin yaşamaya devam etmesine güvenmez. Dış etkiler için “exactly once” iddiası yerine açık stratejiler, kararlı işlem anahtarları, yetki rezervasyonları, alındılar ve reconciliation uygulanır.

## Durum ve lisans

- Uygulama durumu: özel yerel bootstrap; public release yetkilendirilmedi.
- Lisans: Apache-2.0.
- Kanonik public dil: İngilizce; gerekli sayfalar için Türkçe eş içerik sağlanır.
- Telemetri: gizli phone-home telemetrisi yoktur; yapılandırılmış gözlemlenebilirlik varsayılan olarak yalnızca metadata taşır.

Güvenlik bildirimleri [SECURITY.md](./SECURITY.md), genel destek sınırları [SUPPORT.md](./SUPPORT.md) üzerinden takip edilir.
