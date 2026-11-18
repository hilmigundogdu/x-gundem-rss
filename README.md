# X gündem RSS

X (Twitter) trendlerini bölge bölge RSS 2.0 beslemelerine çevirir. Her trend öğesinde o ülkenin dilinde son 24 saatin haberleri vardır; haber bulunamayan trendde (çoğunlukla etiket kampanyaları) en beğenilen tweet'ler gösterilir.

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
| Japonya | https://hilmigundogdu.github.io/x-gundem-rss/japonya.xml |
| Güney Kore | https://hilmigundogdu.github.io/x-gundem-rss/guney-kore.xml |
| Hindistan | https://hilmigundogdu.github.io/x-gundem-rss/hindistan.xml |
| Rusya | https://hilmigundogdu.github.io/x-gundem-rss/rusya.xml |
| X'in haber sayfaları | https://hilmigundogdu.github.io/x-gundem-rss/haberler.xml |

X'te "Avrupa" diye bir trend bölgesi yok; Avrupa ülke ülke verilir. Çin beslemesi yok: X Çin'de yasaklı, oraya trend yayımlamıyor (trends24'te de yok).

## Öğeler

- **Trend** (bölge beslemeleri): başlık trendin adıdır, bağlantı X'teki aramasını açar (X'te trende tıklayınca açılan sayfa). `guid` bölge ve trend adından oluşur, değişmez; `pubDate` trendin o bölgede ilk görüldüğü andır. İçerik sırasıyla:
  - X'in kategorisi biliniyorsa (ör. "Politics"; "Trending worldwide" gibi genel etiketler alınmaz),
  - X trendi habere çevirdiyse o haberin sayfası (`x.com/i/trending/<id>`; Grok özeti ve gönderiler orada) ve görseli,
  - o ülkenin dilinde son 24 saatin 3 haberi (başlık, yayın, saat),
  - haber yoksa en beğenilen 3 tweet (metin, görsel ya da video kapağı, alıntı, yazar, beğeni, RT, tarih),
  - İngilizce ve Türkçe dışındaki metinler için ayırıcının altında **Çeviri** bölümü: trend adı, başlıklar ya da tweet'ler (alıntılarıyla) öğedeki sırayla, her biri EN ve TR; özgün metinler yerinde kalır,
  - ABD, Birleşik Krallık, Türkiye ve Dünya dışındaki bölgelerde ayrı bölüm olarak aynı konunun 3 **İngilizce haberi** (bölgenin listesinde de olan başlık tekrarlanmaz); trend adı çeviriyle arandıysa arama terimi yazılır,
  - sıra ve ilk görülme anı: okuma sayfasında (`content:encoded`) en başta, özette (`description`) en sonda.
- Gündemden düşen trend 24 saat daha beslemede kalır, içinde "gündemden düştü" yazar. Beslemede en çok 40 öğe olur.
- **X haberi** (`haberler.xml`): X'in Keşfet sekmelerinde (Sana özel, Gündem, Haberler, Spor, Eğlence) habere çevirdiği konular; kategori, gönderi sayısı, görsel ve X'teki sayfasının bağlantısı. Oturum hesabının konumuna göre gelir.

## Nasıl çalışır

- GitHub Actions her 30 dakikada `gundem.mjs`'i çalıştırır (GitHub zamanlanmış işi geciktirebiliyor; pratikte 1–3 saatte bir) ve çıktıyı GitHub Pages'te yayımlar. Depoya commit atılmaz; her çalışma dosyaları yeniden üretir, adresler değişmez.
- **Trend listesi** [trends24.in](https://trends24.in/)'den alınır: X'in bölge trendlerini saatlik yayımlar, kimlik istemez. En son anlık görüntünün ilk 10 trendi beslemeye girer; listenin tamamı trend sörfü süzgecinde kullanılır. Cloudflare Actions'tan gelen bir isteği ara ara reddettiği için alınamayan bölge 5 sn sonra bir kez daha denenir; yine alınamazsa önceki listesi yerinde kalır.
- **Haberler** Google News'in arama RSS'inden gelir: `"trend" when:1d`, bölgenin ülkesi ve diliyle (Dünya için ABD İngilizcesi, çok dilli Hindistan için Hindistan İngilizcesi). Etiket okunur biçimiyle aranır (`#TheGameAwards` → "The Game Awards"). Önce haberi hiç çekilmemiş trendler, sonra gündemde kalanlar en çok 2 saatte bir; çalışma başına en çok 100 istek, aralarında 1 sn. **İngilizce haberler** aynı bütçeden, bölgenin kendi haberlerinden sonra Google News'in ABD baskısında aranır: Latin harfli ad olduğu gibi, öteki yazılardaki ad İngilizce çevirisiyle ("Крым" → "Crimea"; çevirisi ilk çalışmada yoksa sonrakinde). Bölgeler arasında ortak terim bir kez aranır. Genel bir kelime olan trend adı (ör. "Mara") alakasız haber getirebilir.
- **Tweet'ler** yalnız haberi bulunamayan trendler için [bird](https://github.com/steipete/bird) CLI'yla, X'in web GraphQL'inden oturum çerezleriyle aranır: `"trend" lang:<bölge dili; Dünya ve Hindistan'da yok> min_faves:<eşik> since_time:<24 saat önce> -filter:retweets -filter:replies`. 3'ten az uygun tweet kalırsa dil süzgeci kalkar, beğeni eşiği onda birine iner. bird yalnız "Latest" araması yaptığı için en beğenilenler son 20–40 tweet içinden seçilir. Çalışma başına en çok 30 arama, aralarında 2 sn; tweet'ler en çok 3 saatte bir, tweet bulunamayan trendde saatte bir yenilenir. Bölgeler arasında ortak trend bir kez aranır; X arama sınırına takılınca aramalar sonraki çalışmaya kalır.
- **Trend sörfü süzgeci:** Görünürlük için o anki trendleri alt alta dizen tweet'ler atılır. Bir satır yalnız trend adlarından, etiketlerden ve bağlantılardan oluşuyorsa etiket satırıdır; aranan trend düz yazıda geçmiyor ve etiket satırlarında başka trendler de diziliyse (düz adda en az 2, etikette en az 3) tweet konu dışıdır. Arama sonuçlarının en az yarısında aranan trendle birlikte geçen trendler "kardeş" sayılır, sayıma girmez: bir kampanyanın etiketleri birlikte kullanılır (ölçümde %65–100), sörfle gelen etiketler sonuçların ~%30'unda kalır. Saklı tweet'ler her çalışmada yeniden süzülür.
- **Çeviri** Google Translate'in anahtarsız ucundan (`translate_a/t?client=gtx`) gelir; X'in "Gönderiyi çevir" düğmesi de Google çevirisi gösterir, X'in kendi ucu ise yalnız tweet çevirir, başlık çeviremez. ABD, Birleşik Krallık ve Türkiye dışındaki bölgelerde öğedeki metinler 40'arlı istekle önce İngilizceye çevrilir; dili İngilizce ya da Türkçe olan, ya da çevirisi aynı kalan (özel ad) metin çevrilmez, kalanlar Türkçeye de çevrilir. Çeviri `state.json`'da metnin kendisiyle saklanır, her metin bir kez çevrilir; Google'a ulaşılamazsa öğe çevirisiz yayımlanır, sonraki çalışmada yeniden denenir.
- **X'in Keşfet sekmeleri** (bird) trend kategorilerini ve X'in habere çevirdiği konuları verir. Trend adı (etiketse okunur biçimi) son 6 saatte görülmüş bir X haberinin başlığında tam söz olarak geçiyorsa o haber trende bağlanır.
- **Durum** `state.json` olarak beslemelerle birlikte yayımlanır; her çalışma onu okuyarak ilk görülme anlarını, haberleri, tweet'leri ve çevirileri taşır. Yalnız 404 sıfırdan başlatır; başka hatada yayın yapılmaz, eski beslemeler yerinde kalır.

## Sırlar

X oturum çerezleri depo sırlarındadır, depoda ve günlükte görünmez:

- `X_AUTH_TOKEN`: x.com'un `auth_token` çerezi
- `X_CT0`: x.com'un `ct0` çerezi

X'ten çıkış yapılırsa çerezler geçersiz olur; tarayıcıdan yenilerini alıp `gh secret set X_AUTH_TOKEN -R hilmigundogdu/x-gundem-rss` ile güncelleyin. Çerezler yoksa ya da geçersizse trend listeleri ve haberler yine yayımlanır; tweet, kategori ve X haberleri önceki çalışmadan kalır.

## Yerel deneme

Node 22 ve `npm install -g @steipete/bird`; çerezler `AUTH_TOKEN`/`CT0` (ya da `BIRD_AUTH_TOKEN`/`BIRD_CT0`) ortam değişkenlerinde.

```sh
node gundem.mjs --out /tmp/xg --budget 5 --press-budget 20 --regions turkiye,abd        # sıfırdan
node gundem.mjs --prev /tmp/xg/state.json --out /tmp/xg2 --budget 5 --press-budget 20 --regions turkiye,abd
```
