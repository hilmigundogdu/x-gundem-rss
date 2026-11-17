# X gündem RSS

X (Twitter) trendlerini bölge bölge RSS 2.0 beslemelerine çevirir. Her trend öğesinde o konunun son 24 saatteki en beğenilen tweet'leri vardır.

| Besleme | Adres |
|---|---|
| Dünya | https://hilmigundogdu.github.io/x-gundem-rss/dunya.xml |
| ABD | https://hilmigundogdu.github.io/x-gundem-rss/abd.xml |
| Türkiye | https://hilmigundogdu.github.io/x-gundem-rss/turkiye.xml |
| Birleşik Krallık | https://hilmigundogdu.github.io/x-gundem-rss/birlesik-krallik.xml |
| Almanya | https://hilmigundogdu.github.io/x-gundem-rss/almanya.xml |
| Fransa | https://hilmigundogdu.github.io/x-gundem-rss/fransa.xml |
| İspanya | https://hilmigundogdu.github.io/x-gundem-rss/ispanya.xml |
| İtalya | https://hilmigundogdu.github.io/x-gundem-rss/italya.xml |
| Hollanda | https://hilmigundogdu.github.io/x-gundem-rss/hollanda.xml |
| X gündem haberleri | https://hilmigundogdu.github.io/x-gundem-rss/haberler.xml |

X'te "Avrupa" diye bir trend bölgesi yok; Avrupa ülke ülke verilir.

## Öğeler

- **Trend** (bölge beslemeleri): başlık trendin adıdır, bağlantı X'teki aramasını açar. `guid` bölge ve trend adından oluşur, değişmez; `pubDate` trendin o bölgede ilk görüldüğü andır. İçerikte son 24 saatin en beğenilen 5 tweet'i (metin, görsel ya da video kapağı, alıntı, yazar, beğeni, RT, tarih ve tweet bağlantısı), X'in kategorisi biliniyorsa (ör. "Politics") o, en sonda sıra ve ilk görülme anı vardır. İlk tweet'in görseli okuyucuda kapak olur.
- Gündemden düşen trend 24 saat daha beslemede kalır, içinde "gündemden düştü" yazar. Beslemede en çok 40 öğe olur.
- **Gündem haberi** (`haberler.xml`): X'in Keşfet'teki gündem haberleri (Grok'un derlediği başlıklar); kategori, gönderi sayısı, görsel ve X'teki haber sayfasının bağlantısı. X'te özet metni ayrı bir yerde durduğu için beslemede yoktur. Haberler oturum hesabının konumuna göre gelir.

## Nasıl çalışır

- GitHub Actions her 30 dakikada `gundem.mjs`'i çalıştırır (GitHub zamanlanmış işi geciktirebiliyor; pratikte 1–3 saatte bir) ve çıktıyı GitHub Pages'te yayımlar. Depoya commit atılmaz; her çalışma dosyaları yeniden üretir, adresler değişmez.
- **Trend listesi** [trends24.in](https://trends24.in/)'den alınır: X'in bölge trendlerini saatlik yayımlar, kimlik istemez. Sayfadaki en son anlık görüntünün ilk 10 trendi kullanılır.
- **Tweet'ler, kategoriler ve haberler** [bird](https://github.com/steipete/bird) CLI'yla, X'in web GraphQL'inden oturum çerezleriyle çekilir. Arama `"trend" lang:<bölge dili> min_faves:<eşik> since_time:<24 saat önce> -filter:retweets -filter:replies` biçimindedir; 3'ten az tweet gelirse dil süzgeci kalkar, beğeni eşiği onda birine iner. Gelenler beğeniye göre sıralanır. bird yalnız "Latest" araması yaptığı için en beğenilenler son 20 tweet içinden seçilir.
- Arama sınırı: bir çalışmada en çok 40 arama, aralarında 2 sn. Önce tweet'i hiç çekilmemiş trendler (iyi sıradan başlayarak) aranır; gündemde kalan trendin tweet'leri en çok 3 saatte bir, tweet bulunamayanınki saatte bir yenilenir. Bölgeler arasında ortak trend bir kez aranır. X arama sınırına takılınca aramalar sonraki çalışmaya kalır.
- **Durum** `state.json` olarak beslemelerle birlikte yayımlanır; her çalışma onu okuyarak ilk görülme anlarını ve çekilmiş tweet'leri taşır. Yalnız 404 sıfırdan başlatır; başka hatada yayın yapılmaz, eski beslemeler yerinde kalır.
- Bir bölgenin trends24 sayfası alınamazsa o bölgenin önceki listesi yerinde kalır. Hiçbir bölge alınamazsa iş düşer.
- **Kategori:** X'in trend sekmesi oturum hesabının konumuna göre gelir; oradaki kategoriler (reklamlı trendler hariç) aynı adlı trendlere eklenir.

## Sırlar

X oturum çerezleri depo sırlarındadır, depoda ve günlükte görünmez:

- `X_AUTH_TOKEN`: x.com'un `auth_token` çerezi
- `X_CT0`: x.com'un `ct0` çerezi

X'ten çıkış yapılırsa çerezler geçersiz olur; tarayıcıdan yenilerini alıp `gh secret set X_AUTH_TOKEN -R hilmigundogdu/x-gundem-rss` ile güncelleyin. Çerezler yoksa ya da geçersizse trend listeleri yine yayımlanır, tweet'ler önceki çalışmadan kalır.

## Yerel deneme

Node 22 ve `npm install -g @steipete/bird`; çerezler `AUTH_TOKEN`/`CT0` (ya da `BIRD_AUTH_TOKEN`/`BIRD_CT0`) ortam değişkenlerinde.

```sh
node gundem.mjs --out /tmp/xg --budget 5 --regions turkiye,abd                     # sıfırdan, 5 arama
node gundem.mjs --prev /tmp/xg/state.json --out /tmp/xg2 --budget 5 --regions turkiye,abd
```
