#!/usr/bin/env node
// X (Twitter) trendlerini bölge bölge RSS 2.0 beslemelerine çevirir (Node 22). Her trend öğesinde o ülkenin dilinde son 24 saatin
// haberleri vardır; haber bulunamayan trendde (çoğunlukla etiket kampanyaları) en beğenilen tweet'ler gösterilir.
// Trend listesi trends24.in'den (X'in bölge trendlerini saatlik yayımlar; kimlik istemez), haberler Google News'in arama RSS'inden
// gelir; ülkenin haberleri İngilizce ya da Türkçe değilse aynı trend İngilizce haberlerde de aranır. Tweet'ler, X'in haber sayfaları (haberler.xml) ve trend kategorileri bird CLI'yla (@steipete/bird, X'in web GraphQL'i,
// oturum çerezi) çekilir. İngilizce ve Türkçe dışındaki trend adı, başlık ve tweet'lerin İngilizce ve Türkçe çevirisi öğenin
// sonuna eklenir (Google Translate'in anahtarsız ucu; X'in "çevir" düğmesi de Google çevirisi gösterir).
//
// Ortam:  BASE_URL     yayımlanmış sitenin adresi; önceki durum BASE_URL/state.json'dan okunur (ilk görülme anları, haberler, tweet'ler, çeviriler).
//         OUT_DIR      çıktı klasörü (varsayılan: public).
//         AUTH_TOKEN, CT0   X oturum çerezleri (bird okur; yerelde BIRD_AUTH_TOKEN ve BIRD_CT0 de olur). Yoksa tweet, kategori ve
//                      X haberi çekilmez; trend listeleri ve Google News haberleri yine yayımlanır.
//         BIRD         bird komutu (varsayılan: bird).
// Yerel deneme:  node gundem.mjs [--prev eski/state.json] [--out klasor] [--budget 5] [--press-budget 10] [--regions turkiye,abd]

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const REPO = 'https://github.com/hilmigundogdu/x-gundem-rss';
const USER_AGENT = `x-gundem-rss/1.0 (+${REPO})`;
const TRENDS24 = 'https://trends24.in/';
const GNEWS = 'https://news.google.com/rss/search';
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const TOP = 10;                             // bölge başına beslemeye giren trend
const PRESS_ITEMS = 3;                      // trend öğesindeki haber
const PRESS_BUDGET = 140;                   // bir çalışmadaki en çok Google News isteği; Actions'tan ~150'de 429 geliyor (2026-11-18)
const PRESS_GAP_MS = 1_000;                 // Google News istekleri arasındaki en kısa ara
const PRESS_REFRESH_MS = 2 * HOUR;          // gündemde kalan trendin haberleri en çok bu sıklıkla yenilenir
const TWEETS = 3;                           // haber bulunamayan trend öğesindeki tweet
const SEARCH_BUDGET = 30;                   // bir çalışmadaki en çok X araması (X'in arama sınırı hesap başına 15 dakikada ~50)
const SEARCH_GAP_MS = 2_000;                // aramalar arasındaki en kısa ara
const REFRESH_MS = 3 * HOUR;                // gündemde kalan trendin tweet'leri en çok bu sıklıkla yenilenir
const RETRY_MS = HOUR;                      // tweet bulunamayan trend bu süre sonra yeniden aranır
const WINDOW_MS = DAY;                      // haber ve tweet'ler bu kadar yeni olmalı
const KEEP_MS = DAY;                        // gündemden düşen trend son görülmesinden sonra bu kadar süre beslemede kalır
const MAX_ITEMS = 40;                       // bölge beslemesindeki en çok öğe
const STORY_KEEP_MS = 3 * DAY;              // X haberi son görülmesinden sonra bu kadar süre kalır
const STORY_MATCH_MS = 6 * HOUR;            // trend öğesine yalnız bu kadar yakın zamanda görülmüş X haberi bağlanır
const ENGLISH_NEWS = 'hl=en-US&gl=US&ceid=US:en'; // İngilizce haber araması: Google News'in ABD baskısı
const TRANSLATE = 'https://translate.googleapis.com/translate_a/t';
const TRANSLATE_BATCH = 40, TRANSLATE_CHARS = 4_000; // bir çeviri isteğindeki en çok metin ve karakter
const TRANSLATE_GAP_MS = 1_000;             // çeviri istekleri arasındaki en kısa ara
const FETCH_TIMEOUT_MS = 30_000;
const BIRD_TIMEOUT_MS = 90_000;

// faves: ilk tweet aramasındaki beğeni eşiği; lang: X'in dil süzgeci (Dünya'da ve çok dilli ülkelerde yok: Hindistan, BAE, Pakistan,
// Filipinler, Singapur); news: Google News'in ülke ve dil parametreleri. Çin ve İran yok: X orada yasaklı, trends24'te sayfaları yok.
const REGIONS = [
  { slug: 'dunya', name: 'Dünya', where: 'Dünyada', path: '', lang: null, faves: 500, news: 'hl=en-US&gl=US&ceid=US:en' },
  { slug: 'abd', name: 'ABD', where: "ABD'de", path: 'united-states/', lang: 'en', faves: 500, news: 'hl=en-US&gl=US&ceid=US:en' },
  { slug: 'turkiye', name: 'Türkiye', where: "Türkiye'de", path: 'turkey/', lang: 'tr', faves: 100, news: 'hl=tr&gl=TR&ceid=TR:tr' },
  { slug: 'birlesik-krallik', name: 'Birleşik Krallık', where: "Birleşik Krallık'ta", path: 'united-kingdom/', lang: 'en', faves: 200, news: 'hl=en-GB&gl=GB&ceid=GB:en' },
  { slug: 'almanya', name: 'Almanya', where: "Almanya'da", path: 'germany/', lang: 'de', faves: 100, news: 'hl=de&gl=DE&ceid=DE:de' },
  { slug: 'fransa', name: 'Fransa', where: "Fransa'da", path: 'france/', lang: 'fr', faves: 100, news: 'hl=fr&gl=FR&ceid=FR:fr' },
  { slug: 'ispanya', name: 'İspanya', where: "İspanya'da", path: 'spain/', lang: 'es', faves: 100, news: 'hl=es&gl=ES&ceid=ES:es' },
  { slug: 'italya', name: 'İtalya', where: "İtalya'da", path: 'italy/', lang: 'it', faves: 100, news: 'hl=it&gl=IT&ceid=IT:it' },
  { slug: 'hollanda', name: 'Hollanda', where: "Hollanda'da", path: 'netherlands/', lang: 'nl', faves: 50, news: 'hl=nl&gl=NL&ceid=NL:nl' },
  { slug: 'japonya', name: 'Japonya', where: "Japonya'da", path: 'japan/', lang: 'ja', faves: 500, news: 'hl=ja&gl=JP&ceid=JP:ja' },
  { slug: 'guney-kore', name: 'Güney Kore', where: "Güney Kore'de", path: 'korea/', lang: 'ko', faves: 200, news: 'hl=ko&gl=KR&ceid=KR:ko' },
  { slug: 'hindistan', name: 'Hindistan', where: "Hindistan'da", path: 'india/', lang: null, faves: 200, news: 'hl=en-IN&gl=IN&ceid=IN:en' },
  { slug: 'rusya', name: 'Rusya', where: "Rusya'da", path: 'russia/', lang: 'ru', faves: 50, news: 'hl=ru&gl=RU&ceid=RU:ru' },
  { slug: 'kanada', name: 'Kanada', where: "Kanada'da", path: 'canada/', lang: 'en', faves: 100, news: 'hl=en-CA&gl=CA&ceid=CA:en' },
  { slug: 'meksika', name: 'Meksika', where: "Meksika'da", path: 'mexico/', lang: 'es', faves: 200, news: 'hl=es-419&gl=MX&ceid=MX:es-419' },
  { slug: 'brezilya', name: 'Brezilya', where: "Brezilya'da", path: 'brazil/', lang: 'pt', faves: 500, news: 'hl=pt-BR&gl=BR&ceid=BR:pt-419' },
  { slug: 'arjantin', name: 'Arjantin', where: "Arjantin'de", path: 'argentina/', lang: 'es', faves: 200, news: 'hl=es-419&gl=AR&ceid=AR:es-419' },
  { slug: 'suudi-arabistan', name: 'Suudi Arabistan', where: "Suudi Arabistan'da", path: 'saudi-arabia/', lang: 'ar', faves: 500, news: 'hl=ar&gl=SA&ceid=SA:ar' },
  { slug: 'bae', name: 'BAE', where: "BAE'de", path: 'united-arab-emirates/', lang: null, faves: 50, news: 'hl=ar&gl=AE&ceid=AE:ar' },
  { slug: 'israil', name: 'İsrail', where: "İsrail'de", path: 'israel/', lang: 'he', faves: 50, news: 'hl=he&gl=IL&ceid=IL:he' },
  { slug: 'misir', name: 'Mısır', where: "Mısır'da", path: 'egypt/', lang: 'ar', faves: 200, news: 'hl=ar&gl=EG&ceid=EG:ar' },
  { slug: 'nijerya', name: 'Nijerya', where: "Nijerya'da", path: 'nigeria/', lang: 'en', faves: 200, news: 'hl=en-NG&gl=NG&ceid=NG:en' },
  { slug: 'kenya', name: 'Kenya', where: "Kenya'da", path: 'kenya/', lang: 'en', faves: 100, news: 'hl=en-KE&gl=KE&ceid=KE:en' },
  { slug: 'guney-afrika', name: 'Güney Afrika', where: "Güney Afrika'da", path: 'south-africa/', lang: 'en', faves: 100, news: 'hl=en-ZA&gl=ZA&ceid=ZA:en' },
  { slug: 'pakistan', name: 'Pakistan', where: "Pakistan'da", path: 'pakistan/', lang: null, faves: 200, news: 'hl=en-PK&gl=PK&ceid=PK:en' },
  { slug: 'endonezya', name: 'Endonezya', where: "Endonezya'da", path: 'indonesia/', lang: 'id', faves: 500, news: 'hl=id&gl=ID&ceid=ID:id' },
  { slug: 'filipinler', name: 'Filipinler', where: "Filipinler'de", path: 'philippines/', lang: null, faves: 200, news: 'hl=en-PH&gl=PH&ceid=PH:en' },
  { slug: 'singapur', name: 'Singapur', where: "Singapur'da", path: 'singapore/', lang: null, faves: 100, news: 'hl=en-SG&gl=SG&ceid=SG:en' },
  { slug: 'avustralya', name: 'Avustralya', where: "Avustralya'da", path: 'australia/', lang: 'en', faves: 100, news: 'hl=en-AU&gl=AU&ceid=AU:en' },
];

// Öğe başlığının başındaki bayrak: Google News'in ülke kodundan (gl=ES → 🇪🇸; bölgesel gösterge harfleri). Dünya'nınki 🌍.
const flagOf = region => region.path ? String.fromCodePoint(...(/gl=([A-Z]{2})/.exec(region.news)[1]).split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🌍';

const { values: args } = parseArgs({ options: {
  prev: { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' }, 'press-budget': { type: 'string' }, regions: { type: 'string' },
} });
const baseUrl = (process.env.BASE_URL || '').replace(/\/?$/, '/');
const outDir = args.out || process.env.OUT_DIR || 'public';
const budget = args.budget ? Number(args.budget) : SEARCH_BUDGET;
const pressBudget = args['press-budget'] ? Number(args['press-budget']) : PRESS_BUDGET;
const regions = args.regions ? REGIONS.filter(r => args.regions.split(',').includes(r.slug)) : REGIONS;
if (!regions.length || !(budget >= 0) || !(pressBudget >= 0)) { console.error('HATA: --regions, --budget ya da --press-budget geçersiz.'); process.exit(2); }
const BIRD = process.env.BIRD || 'bird';
const auth = { AUTH_TOKEN: process.env.AUTH_TOKEN || process.env.BIRD_AUTH_TOKEN || '', CT0: process.env.CT0 || process.env.BIRD_CT0 || '' };
const hasAuth = Boolean(auth.AUTH_TOKEN && auth.CT0);

// ---- Yardımcılar

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => e[0] !== '#' ? ENTITIES[e.toLowerCase()] ?? all
  : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const esc = s => String(s).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = s => `<![CDATA[${String(s).replace(INVALID_XML, '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const keyOf = name => name.normalize('NFC').toLowerCase();
// Karşılaştırma biçimi: küçük harf, # ve boşluksuz ("#TuzluKahve" ile "Tuzlu Kahve" aynı olur).
const squash = s => s.normalize('NFC').toLowerCase().replace(/[#\s_]+/g, '');
// Etiketin okunur biçimi: "#TheGameAwards" → "The Game Awards", "#a_b" → "a b".
const words = name => name.replace(/^#/, '').replace(/_+/g, ' ').replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').replace(/(\p{L})(\d)/gu, '$1 $2').replace(/\s+/g, ' ').trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const searchUrl = name => `https://x.com/search?q=${encodeURIComponent(name)}&src=trend_click`;
const storyUrl = id => `https://x.com/i/trending/${id}`;
const tweetUrl = t => `https://x.com/${t.user}/status/${t.id}`;
const number = n => new Intl.NumberFormat('tr-TR').format(n ?? 0);
const compact = n => new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
// İstanbul saatiyle "17.11 22:20".
function time(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}
const firstLine = s => String(s).trim().split('\n').find(Boolean)?.slice(0, 300) ?? '';
const LANG_NAMES = new Intl.DisplayNames(['tr'], { type: 'language' });
const langName = code => { try { return LANG_NAMES.of(code); } catch { return code; } };
const sameText = (a, b) => a.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim() === b.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

// bird'ü çalıştırır, JSON çıktısını döndürür. Çerezler yalnız alt sürecin ortamına verilir; hiçbir yere yazılmaz.
function bird(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIRD, [...argv, '--timeout', '30000', '--no-color'], {
      env: { ...process.env, ...auth, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), BIRD_TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const start = out.search(/^[[{]/m);
      if (code === 0 && start >= 0) {
        try { return resolve(JSON.parse(out.slice(start))); } catch { /* aşağıda hata olur */ }
      }
      reject(new Error(firstLine(err) || firstLine(out) || `bird ${code ?? 'zaman aşımı'} ile çıktı`));
    });
  });
}
const rateLimited = e => /\b429\b|rate.?limit/i.test(e.message);

// Sırayla giden, aralarında en az gap olan ve bütçesi biten istek kuyruğu.
function limiter(max, gap) {
  const self = { used: 0, async run(call) {
    if (self.used >= max) throw Object.assign(new Error('bütçe bitti'), { budget: true });
    if (self.used) await sleep(gap);
    self.used++;
    return call();
  } };
  return self;
}

// ---- Durum: önceki çalışmanın state.json'u; ilk görülme anlarını, haberleri ve tweet'leri taşır.
// regions[slug].trends[anahtar], press["slug:anahtar"], tweets[anahtar], context[anahtar], stories[id] (X haberleri),
// translations[özgün metin] = { lang, en, tr } (çeviri gerekmiyorsa en ve tr null), english[arama terimi] = { at, list } (İngilizce haberler).

const emptyState = () => ({ version: 2, regions: {}, press: {}, tweets: {}, context: {}, stories: {}, translations: {}, english: {} });

async function loadState() {
  let raw;
  if (args.prev) raw = JSON.parse(await readFile(args.prev, 'utf8'));
  else if (!process.env.BASE_URL) { console.log('BASE_URL yok; sıfırdan başlanıyor.'); return emptyState(); }
  else {
    const res = await get(`${baseUrl}state.json?t=${Date.now()}`);
    if (res.status === 404) { console.log('Önceki durum yok; sıfırdan başlanıyor.'); return emptyState(); }
    if (!res.ok) throw new Error(`Önceki durum okunamadı (HTTP ${res.status}); ilk görülme anları kaybolmasın diye yayın yapılmadı.`);
    raw = JSON.parse(res.body);
  }
  // Sürüm 1'de X haberleri "news" adındaydı, kategoriler süzülmeden yazılıyordu.
  if (raw.version === 1) { raw.stories = raw.news ?? {}; delete raw.news; raw.version = 2; }
  const state = { ...emptyState(), ...raw };
  for (const [key, c] of Object.entries(state.context)) {
    c.category = cleanCategory(c.category);
    if (!c.category && !c.description) delete state.context[key];
  }
  return state;
}

// ---- trends24: sayfadaki ilk liste en son anlık görüntüdür (saatlik). İlk TOP trend beslemeye girer; listenin tamamı
// trend sörfü süzgecinde kullanılır.

function parseTrends24(html) {
  const head = /class=["']?title["']? data-timestamp=["']?([\d.]+)/.exec(html);
  const start = html.indexOf('trend-card__list', head?.index ?? 0);
  const end = html.indexOf('</ol>', start);
  if (!head || start < 0 || end < 0) throw new Error('trends24 sayfasında trend listesi bulunamadı.');
  const all = [...new Set([...html.slice(start, end).matchAll(/<a\b[^>]*class=["']?trend-link["']?[^>]*>([^<]+)<\/a>/g)]
    .map(m => decode(m[1]).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!all.length) throw new Error('trends24 listesi boş.');
  return { at: Math.round(parseFloat(head[1]) * 1000), names: all.slice(0, TOP), all };
}

// Cloudflare Actions'tan ana sayfaya (Dünya) gelen isteği ülke sayfalarından çok daha sık reddediyor (403); aynı sayfa
// index.html adından da sunuluyor, ana sayfa reddedilince o denenir.
async function fetchTrends(region) {
  let res = await get(TRENDS24 + region.path);
  if (res.status === 403 && !region.path) {
    res = await get(`${TRENDS24}index.html`);
    console.log(`${region.name}: ana sayfa 403 verdi, index.html ${res.ok ? 'alındı' : `de reddedildi (HTTP ${res.status})`}.`);
  }
  if (!res.ok) throw new Error(`trends24 HTTP ${res.status}`);
  return parseTrends24(res.body);
}

// ---- Çeviri: Google Translate'in anahtarsız ucu birden çok metni bir istekte çevirir, her metnin dilini ayrı tespit eder
// ([[çeviri, dil], …]); çok satırlı metin satırlarını korur.

async function translate(texts, target) {
  const body = new URLSearchParams(texts.map(q => ['q', q]));
  const res = await fetch(`${TRANSLATE}?client=gtx&sl=auto&tl=${target}`, {
    method: 'POST', body, headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  const data = await res.json();
  const list = texts.length === 1 && typeof data?.[0] === 'string' ? [data] : data;
  if (!Array.isArray(list) || list.length !== texts.length) throw new Error('Google Translate yanıtı beklenen biçimde değil.');
  return list.map(([text, lang]) => ({ text: String(text ?? ''), lang: String(lang ?? '') }));
}

// Önce İngilizceye çevrilir: dil İngilizce ya da Türkçeyse, belirlenemediyse ya da çeviri özgünün aynısıysa (özel ad) çeviri
// gerekmez. Kalanlar Türkçeye çevrilir.
async function translateAll(texts, cache, queue) {
  const chunks = [];
  for (const text of texts) {
    const last = chunks.at(-1);
    if (last && last.length < TRANSLATE_BATCH && last.reduce((n, t) => n + t.length, text.length) <= TRANSLATE_CHARS) last.push(text);
    else chunks.push([text]);
  }
  let done = 0;
  for (const chunk of chunks) {
    const en = await queue.run(() => translate(chunk, 'en'));
    const foreign = chunk.filter((text, i) => en[i].lang && !['en', 'tr', 'auto', 'und'].includes(en[i].lang) && !sameText(en[i].text, text));
    const tr = foreign.length ? await queue.run(() => translate(foreign, 'tr')) : [];
    chunk.forEach((text, i) => {
      const at = foreign.indexOf(text), trText = at >= 0 ? tr[at].text : null;
      cache[text] = at < 0 ? { lang: en[i].lang, en: null, tr: null }
        : { lang: en[i].lang, en: en[i].text, tr: trText && !sameText(trText, text) ? trText : null };
    });
    done += chunk.length;
  }
  return done;
}

// ---- Haberler: Google News'in arama RSS'i, bölgenin ülkesi ve diliyle, son 24 saat. Etiket okunur biçimiyle aranır.

async function fetchPress(term, news) {
  const query = `"${term.replace(/"/g, '')}" when:1d`;
  const res = await get(`${GNEWS}?q=${encodeURIComponent(query)}&${news}`);
  if (!res.ok) throw Object.assign(new Error(`Google News HTTP ${res.status}`), { stop: res.status === 429 || res.status >= 500 });
  const seen = new Set(), list = [];
  for (const [, item] of res.body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = tag => decode(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(item)?.[1] ?? '').trim();
    const source = field('source'), url = field('link'), at = Date.parse(field('pubDate')) || null;
    let title = field('title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -source.length - 3).trim();
    if (!title || !url || seen.has(title.toLowerCase()) || (at && Date.now() - at > WINDOW_MS)) continue;
    seen.add(title.toLowerCase());
    list.push({ title, source, url, at });
    if (list.length >= PRESS_ITEMS) break;
  }
  return list;
}

// İngilizce haber araması dili İngilizce ya da Türkçe olan bölgelerde ve Dünya'da (haberleri zaten ABD baskısından) yapılmaz; çok dilli
// bölgelerde yapılır (Hindistan'ın yerel haberleri İngilizce ama Hintçe trendler orada bulunmaz). Latin harfli ad olduğu gibi aranır; öteki yazılardaki ad
// İngilizce çevirisiyle ("Крым" → "Crimea"; çevirisi henüz yoksa sonraki çalışmada).
const latinOnly = s => !/\p{L}/u.test(s.replace(/\p{Script=Latin}/gu, ''));
function englishTerm(region, name, translations) {
  if (region.lang === 'en' || region.lang === 'tr' || region.news === ENGLISH_NEWS) return null;
  const term = words(name);
  return latinOnly(term) ? term : translations[term]?.en ?? null;
}

// ---- Tweet'ler: X'in "Latest" araması (bird "Top"u desteklemiyor) son 24 saat ve beğeni eşiğiyle süzülür, en beğenilenler alınır.

function searchQuery(name, lang, faves) {
  const q = /^[#$]\S+$/.test(name) ? name : `"${name.replace(/"/g, '')}"`;
  const since = `since_time:${Math.floor((Date.now() - WINDOW_MS) / 1000)}`;
  return [q, lang && `lang:${lang}`, `min_faves:${faves}`, since, '-filter:retweets', '-filter:replies'].filter(Boolean).join(' ');
}

function slim(t) {
  const media = (t.media ?? []).map(m => ({ type: m.type, url: m.url, ...(m.videoUrl ? { video: true } : {}) })).filter(m => m.url).slice(0, 4);
  const q = t.quotedTweet;
  return {
    id: String(t.id), user: t.author?.username ?? 'i', name: t.author?.name ?? '', text: t.text ?? '',
    likes: t.likeCount ?? 0, retweets: t.retweetCount ?? 0, at: Date.parse(t.createdAt) || null, media,
    ...(q?.id ? { quoted: { id: String(q.id), user: q.author?.username ?? 'i', name: q.author?.name ?? '', text: (q.text ?? '').slice(0, 500) } } : {}),
  };
}

// Trend sörfü: görünürlük için o anki trendleri dizen tweet. Bir satır yalnız trend adlarından, etiketlerden ve bağlantılardan
// oluşuyorsa "etiket satırı"dır. Aranan trend düz yazıda geçmiyor ve etiket satırlarında başka trendler de diziliyse
// (düz adda en az 2, etikette en az 3) tweet konu dışıdır. Kardeş trendler sayılmaz: arama sonuçlarının en az yarısında geçen
// trendler aynı konuşmanın parçasıdır (bir kampanyanın etiketleri birlikte kullanılır; sörfle gelen etiketler sonuçların ~%30'unda kalır).
const SIBLING_SHARE = 0.5;
function siblingsOf(tweets, target, names) {
  if (tweets.length < 3) return [];
  const own = squash(target), texts = tweets.map(t => t.text.normalize('NFC').toLowerCase());
  return names.filter(n => squash(n) !== own && texts.filter(x => x.includes(n)).length >= tweets.length * SIBLING_SHARE);
}

function trendSurfing(text, target, names, siblings = []) {
  const own = squash(target), kin = new Set(siblings.map(squash));
  let others = 0, ownInProse = false;
  for (const line of text.split('\n')) {
    let rest = ` ${line.replace(/https?:\/\/\S+/g, ' ').normalize('NFC').toLowerCase()} `;
    const hits = [];
    for (const n of names) if (rest.includes(n)) { hits.push(n); rest = rest.split(n).join(' '); }
    const tagLine = hits.length > 0 && !rest.replace(/[#@][^\s#@]+/g, ' ').replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!tagLine && squash(line).includes(own)) ownInProse = true;
    if (tagLine) others += hits.filter(n => squash(n) !== own && !kin.has(squash(n))).length;
  }
  return !ownInProse && others >= (target.startsWith('#') ? 3 : 2);
}

async function searchTweets(name, region, names, queue) {
  const found = new Map();
  let siblings = [];
  const clean = () => {
    siblings = siblingsOf([...found.values()], name, names);
    return [...found.values()].filter(t => !trendSurfing(t.text, name, names, siblings));
  };
  const run = async query => {
    const list = await queue.run(() => bird(['search', query, '-n', '20', '--json']));
    for (const t of Array.isArray(list) ? list : list?.tweets ?? []) if (t?.id && !found.has(String(t.id))) found.set(String(t.id), slim(t));
  };
  await run(searchQuery(name, region.lang, region.faves));
  // Az tweet kalırsa dil süzgeci kalkar, eşik onda birine iner; gevşek arama bütçeye sığmazsa ilk aramanın sonucu yine kullanılır.
  if (clean().length < TWEETS) await run(searchQuery(name, null, Math.max(1, Math.round(region.faves / 10)))).catch(e => { if (!e.budget || !found.size) throw e; });
  const list = clean().sort((a, b) => b.likes - a.likes).slice(0, TWEETS);
  return { at: Date.now(), name, siblings, list };
}

// ---- X'in kendi bağlamı: Keşfet sekmelerindeki trendlerin kategorisi ve X'in habere çevirdiği konular (x.com/i/trending/<id>).
// İkisi de oturum hesabının konumuna göre gelir.

// "Trending", "Trending in Turkey", "Trending worldwide", "Only on X" kategori değil; "Politics · Trending" → "Politics".
const cleanCategory = c => (c ?? '').split(' · ').map(s => s.trim()).filter(s => s && !/^(Trending\b.*|Only on X)$/i.test(s)).join(' · ');

function contextOf(item) {
  if (/promoted_trend/.test(item.url ?? item.id ?? '')) return null;   // reklamlı trend
  const category = cleanCategory(item.category), description = (item.description ?? '').trim();
  return category || description ? { category, description } : null;
}

// Trend adı (etiketse okunur biçimi) bir X haberinin başlığında tam söz olarak geçiyorsa o haber trende bağlanır.
function storyFor(name, stories, now) {
  const phrase = words(name).toLowerCase();
  if (phrase.length < 3) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(phrase)}($|[^\\p{L}\\p{N}])`, 'u');
  return Object.entries(stories).filter(([, s]) => now - s.lastSeen <= STORY_MATCH_MS && re.test(s.headline.toLowerCase()))
    .sort(([, a], [, b]) => b.lastSeen - a.lastSeen || (b.postCount ?? 0) - (a.postCount ?? 0)).map(([id, s]) => ({ id, ...s }))[0] ?? null;
}

// ---- RSS

const pressList = list => `<ul>\n${list.map(n => `<li><a href="${esc(n.url)}">${esc(n.title)}</a> — ${esc(n.source || 'haber')}${n.at ? ` · ${time(n.at)}` : ''}</li>`).join('\n')}\n</ul>`;
const prose = text => esc(text).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>');

// Haberi olmayan trend öğesinde gösterilen tweet'ler: bu çalışmanın trend listesiyle trend sörfüne karşı süzülür.
const shownTweets = (tweets, name, names) => (tweets?.list ?? []).filter(t => !trendSurfing(t.text, name, names, tweets.siblings)).slice(0, TWEETS);

// Öğede çevrilecek metinler: trend adı (etiketse okunur biçimi), haber başlıkları ya da tweet'ler ve alıntıladıkları.
function originals(name, press, tweets, names) {
  const list = [{ label: 'Trend', text: words(name) }];
  if (press?.list.length) list.push(...press.list.map(n => ({ label: n.source || 'Haber', text: n.title })));
  else for (const t of shownTweets(tweets, name, names)) {
    list.push({ label: `@${t.user}`, text: t.text });
    if (t.quoted?.text) list.push({ label: `@${t.quoted.user} (alıntı)`, text: t.quoted.text });
  }
  return list.filter(o => o.text.trim());
}

// Özgün metinler yerinde kalır; çeviriler ayırıcının altında ayrı bölümdür, öğedeki sırayla.
function translationSection(list, translations) {
  const rows = list.map(o => ({ ...o, t: translations[o.text] })).filter(o => o.t?.en || o.t?.tr);
  if (!rows.length) return [];
  const langs = [...new Set(rows.map(o => langName(o.t.lang)))].join(', ');
  return ['<hr>', `<p><b>Çeviri</b> · ${esc(langs)}</p>`, ...rows.map(o => `<p><b>${esc(o.label)}</b>`
    + `${o.t.en ? `<br><b>EN</b> ${prose(o.t.en)}` : ''}${o.t.tr ? `<br><b>TR</b> ${prose(o.t.tr)}` : ''}</p>`)];
}

function renderTweet(t) {
  const body = prose(t.text);
  const media = t.media.map(m => `<p><a href="${esc(tweetUrl(t))}"><img src="${esc(m.url)}" alt="${m.type === 'photo' ? '' : 'video'}"></a></p>`).join('');
  const quoted = t.quoted ? `<blockquote><p><b>${esc(t.quoted.name)}</b> (@${esc(t.quoted.user)})<br>${esc(t.quoted.text).replace(/\n/g, '<br>')}</p></blockquote>` : '';
  const video = t.media.some(m => m.video) ? ' · ▶ video' : '';
  return `<blockquote><p>${body}</p>${media}${quoted}</blockquote>\n`
    + `<p>— <b>${esc(t.name)}</b> (@${esc(t.user)}) · ${number(t.likes)} beğeni · ${number(t.retweets)} RT${video} · `
    + `<a href="${esc(tweetUrl(t))}">${t.at ? time(t.at) : 'tweet'}</a></p>`;
}

// Okuyucular özeti description'ın ilk satırlarından çıkardığı için orada önce bağlam, X haberi ve haberler, sıra bilgisi en sonda;
// tweet'ler yalnız haber yoksa. Okuma sayfası content:encoded'dır: aynı gövde, sıra bilgisi en başta.
function trendItem(region, seen, { press, tweets, context, story, names, translations, english }) {
  const name = seen.name, lines = [];
  if (context) lines.push(`<p><b>${esc(context.category || 'X')}</b>${context.description ? ` — ${esc(context.description)}` : ''}</p>`);
  if (story) {
    lines.push(`<p><b>X'te:</b> <a href="${storyUrl(story.id)}">${esc(story.headline)}</a>${story.postCount ? ` · ${compact(story.postCount)} gönderi` : ''}</p>`);
    if (story.image) lines.push(`<p><a href="${storyUrl(story.id)}"><img src="${esc(story.image)}" alt=""></a></p>`);
  }
  let note = '';
  if (press?.list.length) {
    lines.push(pressList(press.list));
    note = ` · haberler ${time(press.at)} itibarıyla`;
  } else {
    const list = shownTweets(tweets, name, names);
    if (list.length) { lines.push(...list.map(renderTweet)); note = ` · tweet'ler ${time(tweets.at)} itibarıyla`; }
    else if (!press) lines.push('<p>Haberler henüz çekilmedi.</p>');
    else if (!tweets) lines.push('<p>Son 24 saatte haber yok; tweet\'ler henüz çekilmedi.</p>');
    else lines.push('<p>Son 24 saatte bu konuda haber de beğeni eşiğini geçen tweet de bulunamadı.</p>');
  }
  lines.push(...translationSection(originals(name, press, tweets, names), translations));
  // Arama terimi trendin adından farklıysa (çeviriyle arandıysa) yazılır: eşleşmenin isabeti görülebilsin.
  // Bölgenin kendi listesinde de olan başlık (Hindistan'da ikisi de İngilizce) tekrarlanmaz.
  const extra = (english?.list ?? []).filter(n => !press?.list.some(p => sameText(p.title, n.title) || p.url === n.url));
  if (extra.length) lines.push('<hr>', `<p><b>İngilizce haberler</b>${english.term !== words(name) ? ` · “${esc(english.term)}” araması` : ''}</p>`, pressList(extra));
  const meta = `<p><small>${esc(region.where)} ${seen.rank != null ? `${seen.rank}. sırada · ilk görülme ${time(seen.firstSeen)}`
    : `gündemden düştü · son görülme ${time(seen.lastSeen)}, en iyi sıra ${seen.best}.`}${note} · <a href="${esc(searchUrl(name))}">X'te ara</a></small></p>`;
  return {
    title: `${flagOf(region)} ${name}`, link: searchUrl(name), guid: `x-gundem:${region.slug}:${keyOf(name)}`, date: seen.firstSeen,
    categories: [region.name, ...(context?.category ? [context.category] : [])],
    description: [...lines, meta].join('\n'), content: [meta, ...lines].join('\n'),
  };
}

function render(channel, items, now) {
  const date = ms => new Date(ms).toUTCString();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '<channel>',
    `<title>${esc(channel.title)}</title>`,
    `<link>${esc(channel.link)}</link>`,
    `<description>${esc(channel.description)}</description>`,
    '<language>tr</language>',
    `<lastBuildDate>${date(now)}</lastBuildDate>`,
    '<ttl>30</ttl>',
    `<generator>${REPO}</generator>`,
    ...(process.env.BASE_URL ? [`<atom:link href="${esc(baseUrl + channel.file)}" rel="self" type="application/rss+xml"/>`] : []),
  ];
  for (const item of items) {
    lines.push('<item>',
      `<title>${esc(item.title)}</title>`,
      `<link>${esc(item.link)}</link>`,
      `<guid isPermaLink="false">${esc(item.guid)}</guid>`,
      `<pubDate>${date(item.date)}</pubDate>`,
      ...item.categories.map(c => `<category>${esc(c)}</category>`),
      `<description>${cdata(item.description)}</description>`,
      ...(item.content ? [`<content:encoded>${cdata(item.content)}</content:encoded>`] : []),
      '</item>');
  }
  lines.push('</channel>', '</rss>', '');
  return lines.join('\n');
}

function indexHtml(files, now) {
  const rows = files.map(f => `<li><a href="${esc(f.file)}">${esc(f.title)}</a></li>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>X gündem RSS</title>
<h1>X gündem RSS</h1><p>X trendleri bölge bölge, son 24 saatin haberleriyle. Son üretim: ${time(now)} (İstanbul). <a href="${REPO}">Kaynak</a></p>
<ul>
${rows}
</ul>
`;
}

// ---- Çalışma

async function main() {
  const now = Date.now();
  const state = await loadState();
  if (!hasAuth) console.log('UYARI: X çerezleri yok; tweet, kategori ve X haberi çekilmeyecek.');

  // 1. Bölge trend listeleri. Cloudflare Actions'tan gelen bir isteği ara ara reddediyor (403); düşen bölgeler turun sonunda bir kez daha denenir.
  const lists = new Map(), errors = new Map();
  for (const attempt of [1, 2]) {
    const todo = regions.filter(r => !lists.has(r.slug));
    if (!todo.length) break;
    if (attempt > 1) await sleep(5_000);
    for (const region of todo) {
      try { lists.set(region.slug, await fetchTrends(region)); } catch (e) { errors.set(region.slug, e.message); }
      await sleep(500);
    }
  }
  const current = new Map();   // slug -> beslemeye giren isimler (sıralı)
  const everyName = new Set(); // süzgeç için tüm bölgelerin tam listeleri
  for (const region of regions) {
    const prev = state.regions[region.slug] ?? { at: 0, trends: {} };
    const list = lists.get(region.slug);
    if (!list) {
      console.log(`${region.name}: trend listesi alınamadı (${errors.get(region.slug)}); önceki liste yerinde kalıyor.`);
      state.regions[region.slug] = prev;
      const names = Object.values(prev.trends).filter(t => t.rank != null).sort((a, b) => a.rank - b.rank).map(t => t.name);
      current.set(region.slug, names);
      names.forEach(n => everyName.add(n));
      continue;
    }
    const { at, names, all } = list;
    all.forEach(n => everyName.add(n));
    const trends = {};
    for (const [key, seen] of Object.entries(prev.trends)) trends[key] = { ...seen, rank: null };
    let fresh = 0;
    names.forEach((name, i) => {
      const key = keyOf(name), old = trends[key];
      if (!old) fresh++;
      trends[key] = { name, firstSeen: old?.firstSeen ?? now, lastSeen: now, rank: i + 1, best: Math.min(old?.best ?? Infinity, i + 1) };
    });
    state.regions[region.slug] = { at, trends };
    current.set(region.slug, names);
    console.log(`${region.name}: ${names.length} trend, ${fresh} yeni (trends24 ${time(at)}).`);
  }
  if (![...current.values()].some(n => n.length)) throw new Error('Hiçbir bölgenin trend listesi yok; yayın yapılmadı.');
  for (const slug of Object.keys(state.regions)) for (const seen of Object.values(state.regions[slug].trends)) everyName.add(seen.name);
  // Uzun adlar önce çıkarılsın ("Tuzlu Kahve 12" içinden "Tuzlu Kahve" değil); 3 harften kısa adlar süzgeçte kullanılmaz.
  const names = [...everyName].map(n => n.normalize('NFC').toLowerCase()).filter(n => n.length >= 3).sort((a, b) => b.length - a.length);

  // Düşen ve süresi dolan trendler atılır.
  for (const slug of Object.keys(state.regions)) {
    const trends = state.regions[slug].trends;
    for (const [key, seen] of Object.entries(trends)) if (seen.rank == null && now - seen.lastSeen > KEEP_MS) delete trends[key];
  }

  // Saklı tweet'ler bu çalışmanın trend listesiyle yeniden süzülür; süzgece takılan çıkarsa trend yeniden aranır.
  const nameOf = new Map(Object.values(state.regions).flatMap(r => Object.entries(r.trends).map(([key, seen]) => [key, seen.name])));
  let dropped = 0;
  for (const [key, entry] of Object.entries(state.tweets)) {
    const name = entry.name ?? nameOf.get(key);
    if (!name) continue;
    entry.name = name;
    entry.siblings ??= siblingsOf(entry.list, name, names);
    const kept = entry.list.filter(t => !trendSurfing(t.text, name, names, entry.siblings));
    if (kept.length < entry.list.length) { dropped += entry.list.length - kept.length; entry.list = kept; entry.at = 0; }
  }
  if (dropped) console.log(`Trend sörfü: saklı ${dropped} tweet çıkarıldı; o trendler yeniden aranacak.`);

  // 2. Haberler: önce hiç çekilmemiş trendler (iyi sıradan başlayarak), sonra yenilenmesi gelenler.
  const pressDue = regions.flatMap(region => (current.get(region.slug) ?? []).map((name, i) => ({ region, name, rank: i + 1, id: `${region.slug}:${keyOf(name)}` })))
    .filter(({ id }) => !state.press[id] || now - state.press[id].at >= PRESS_REFRESH_MS)
    .sort((a, b) => Number(Boolean(state.press[a.id])) - Number(Boolean(state.press[b.id])) || a.rank - b.rank);
  const pressQueue = limiter(pressBudget, PRESS_GAP_MS);
  let pressDone = 0, pressFound = 0, pressStopped = false;
  for (const { region, name, id } of pressDue) {
    try {
      const list = await pressQueue.run(() => fetchPress(words(name), region.news));
      state.press[id] = { at: Date.now(), list };
      pressDone++; if (list.length) pressFound++;
    } catch (e) {
      if (e.budget) { pressStopped = true; break; }
      console.log(`"${name}" (${region.name}) haberleri alınamadı: ${e.message}`);
      if (e.stop) { console.log('Google News istekleri sonraki çalışmaya kaldı.'); pressStopped = true; break; }
    }
  }
  console.log(`Haber: ${pressDone}/${pressDue.length} trend güncellendi, ${pressFound} trendde haber var, ${pressQueue.used}/${pressBudget} istek.`);

  // İngilizce haberler, bölgenin kendi haberlerinden sonra aynı bütçeyle. Bölgeler arasında ortak terim bir kez aranır.
  const englishWant = new Map();
  for (const region of regions) (current.get(region.slug) ?? []).forEach((name, i) => {
    const term = englishTerm(region, name, state.translations), had = englishWant.get(term);
    if (term && (had == null || i + 1 < had)) englishWant.set(term, i + 1);
  });
  const englishDue = [...englishWant].filter(([term]) => !state.english[term] || now - state.english[term].at >= PRESS_REFRESH_MS)
    .sort(([a, ra], [b, rb]) => Number(Boolean(state.english[a])) - Number(Boolean(state.english[b])) || ra - rb);
  let englishDone = 0, englishFound = 0;
  const englishStart = pressQueue.used;
  if (!pressStopped) for (const [term] of englishDue) {
    try {
      const list = await pressQueue.run(() => fetchPress(term, ENGLISH_NEWS));
      state.english[term] = { at: Date.now(), list };
      englishDone++; if (list.length) englishFound++;
    } catch (e) {
      if (e.budget) break;
      console.log(`"${term}" İngilizce haberleri alınamadı: ${e.message}`);
      if (e.stop) { console.log('İngilizce haber aramaları sonraki çalışmaya kaldı.'); break; }
    }
  }
  console.log(`İngilizce haber: ${englishDone}/${englishDue.length} terim güncellendi, ${englishFound} terimde haber var, ${pressQueue.used - englishStart} istek.`);

  if (hasAuth) {
    // 3. X'in Keşfet sekmeleri: trend kategorileri ve X'in habere çevirdiği konular.
    try {
      const list = await bird(['trending', '-n', '100', '--json-full']);
      let contexts = 0, stories = 0;
      for (const item of list) {
        if (!item.headline) continue;
        const id = /trending\/(\d+)/.exec(item.id ?? '')?.[1];
        if (id) {
          const old = state.stories[id];
          state.stories[id] = {
            headline: item.headline, category: (item.category ?? '').replace(/^AI · /, ''), postCount: item.postCount ?? old?.postCount ?? null,
            image: item._raw?.images?.[0]?.url ?? item._raw?.thumbnail_image?.original_img_url ?? old?.image ?? null,
            firstSeen: old?.firstSeen ?? now, lastSeen: now,
          };
          stories++;
          continue;
        }
        const ctx = contextOf(item);
        if (ctx) { state.context[keyOf(item.headline)] = { ...ctx, at: now }; contexts++; }
      }
      console.log(`X Keşfet: ${list.length} öğe, ${contexts} kategori, ${stories} haber.`);
    } catch (e) { console.log(`X Keşfet alınamadı: ${e.message}`); }

    // 4. Tweet'ler yalnız haberi bulunamayan trendler için. Bölgeler arasında ortak trend bir kez aranır.
    const want = new Map();
    for (const region of regions) (current.get(region.slug) ?? []).forEach((name, i) => {
      const press = state.press[`${region.slug}:${keyOf(name)}`];
      if (!press || press.list.length) return;
      const key = keyOf(name), had = want.get(key);
      if (!had || i + 1 < had.rank) want.set(key, { name, region, rank: i + 1 });
    });
    const due = [...want].filter(([key]) => { const t = state.tweets[key]; return !t || now - t.at >= (t.list.length ? REFRESH_MS : RETRY_MS); })
      .sort(([ka, a], [kb, b]) => Number(Boolean(state.tweets[ka])) - Number(Boolean(state.tweets[kb])) || a.rank - b.rank);
    const queue = limiter(budget, SEARCH_GAP_MS);
    let done = 0;
    for (const [key, { name, region }] of due) {
      try {
        state.tweets[key] = await searchTweets(name, region, names, queue);
        done++;
      } catch (e) {
        if (e.budget) break;
        console.log(`"${name}" aranamadı: ${e.message}`);
        if (rateLimited(e)) { console.log('X arama sınırına takıldı; aramalar sonraki çalışmaya kaldı.'); break; }
      }
    }
    console.log(`Tweet: ${done}/${due.length} trend güncellendi, ${queue.used}/${budget} arama.`);
  }

  // Artık hiçbir beslemede olmayan haber, tweet, kategori ve X haberleri atılır.
  const live = new Set(Object.entries(state.regions).flatMap(([slug, r]) => Object.keys(r.trends).map(key => `${slug}:${key}`)));
  const liveKeys = new Set([...live].map(id => id.slice(id.indexOf(':') + 1)));
  for (const id of Object.keys(state.press)) if (!live.has(id)) delete state.press[id];
  for (const key of Object.keys(state.tweets)) if (!liveKeys.has(key)) delete state.tweets[key];
  for (const [key, c] of Object.entries(state.context)) if (!liveKeys.has(key) && now - c.at > KEEP_MS) delete state.context[key];
  for (const [id, s] of Object.entries(state.stories)) if (now - s.lastSeen > STORY_KEEP_MS) delete state.stories[id];

  // Beslemeye girecek öğeler: gündemdekiler sırayla, sonra düşenler.
  const listed = region => Object.entries(state.regions[region.slug]?.trends ?? {})
    .sort(([, a], [, b]) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.lastSeen - a.lastSeen)
    .slice(0, MAX_ITEMS)
    .map(([key, seen]) => ({ key, seen, press: state.press[`${region.slug}:${key}`], tweets: state.tweets[key] }));

  // 5. Çeviri: İngilizce ve Türkçe bölgeler dışında, gündemdeki trendlerden başlayarak. Çevrilen metin saklanır, bir kez çevrilir.
  const wanted = new Set(), todo = [];
  for (const pass of ['live', 'dropped']) for (const region of REGIONS) {
    if (region.lang === 'en' || region.lang === 'tr') continue;
    for (const { seen, press, tweets } of listed(region)) {
      if ((seen.rank != null) !== (pass === 'live')) continue;
      for (const { text } of originals(seen.name, press, tweets, names)) {
        if (wanted.has(text)) continue;
        wanted.add(text);
        if (!state.translations[text]) todo.push(text);
      }
    }
  }
  for (const text of Object.keys(state.translations)) if (!wanted.has(text)) delete state.translations[text];
  if (todo.length) {
    const queue = limiter(Infinity, TRANSLATE_GAP_MS);
    let done = 0;
    try { done = await translateAll(todo, state.translations, queue); }
    catch (e) { done = todo.filter(text => state.translations[text]).length; console.log(`Çeviri yarıda kaldı: ${e.message}`); }
    console.log(`Çeviri: ${done}/${todo.length} metin, ${queue.used} istek.`);
  }
  const englishUsed = new Set(REGIONS.flatMap(region => listed(region).map(({ seen }) => englishTerm(region, seen.name, state.translations))));
  for (const term of Object.keys(state.english)) if (!englishUsed.has(term)) delete state.english[term];

  // 6. Yazma.
  await mkdir(outDir, { recursive: true });
  const files = [];
  let linked = 0;
  for (const region of REGIONS) {
    if (!state.regions[region.slug]) continue;
    const items = listed(region).map(({ key, seen, press, tweets }) => {
      const story = storyFor(seen.name, state.stories, now);
      if (story) linked++;
      const term = englishTerm(region, seen.name, state.translations), english = term && state.english[term] ? { term, ...state.english[term] } : null;
      return trendItem(region, seen, { press, tweets, context: state.context[key], story, names, translations: state.translations, english });
    });
    const file = `${region.slug}.xml`, title = `X Trend · ${region.name}`;
    await writeFile(join(outDir, file), render({ file, title, link: `${TRENDS24}${region.path}`,
      description: `${region.where} X trendleri (trends24.in), son 24 saatin haberleriyle.` }, items, now));
    files.push({ file, title });
  }
  const stories = Object.entries(state.stories).sort(([, a], [, b]) => b.lastSeen - a.lastSeen || b.firstSeen - a.firstSeen).map(([id, s]) => ({
    title: s.headline, link: storyUrl(id), guid: `x-gundem:haber:${id}`, date: s.firstSeen,
    categories: ['X Gündem', ...(s.category ? [s.category] : [])],
    description: [`<p>${esc(s.category || 'Haber')}${s.postCount ? ` · ${compact(s.postCount)} gönderi` : ''} · ilk görülme ${time(s.firstSeen)}`
      + ` · <a href="${storyUrl(id)}">X'te aç</a></p>`, ...(s.image ? [`<p><img src="${esc(s.image)}" alt=""></p>`] : [])].join('\n'),
  }));
  await writeFile(join(outDir, 'haberler.xml'), render({ file: 'haberler.xml', title: 'X Gündem · Haberler', link: 'https://x.com/explore/tabs/news',
    description: "X'in Keşfet sekmelerinde habere çevirdiği konular (oturum hesabının konumuna göre)." }, stories, now));
  files.push({ file: 'haberler.xml', title: 'X Gündem · Haberler' });
  await writeFile(join(outDir, 'state.json'), JSON.stringify(state));
  await writeFile(join(outDir, 'index.html'), indexHtml(files, now));
  console.log(`Yazıldı: ${files.length} besleme, ${linked} trende X haberi bağlandı → ${outDir}`);
}

main().catch(e => { console.error(`HATA: ${e.message}`); process.exit(1); });
