#!/usr/bin/env node
// X (Twitter) trendlerini bölge bölge RSS 2.0 beslemelerine çevirir; her trend öğesinde o konunun en beğenilen tweet'leri vardır.
// Trend listesi trends24.in'den alınır (X'in bölge trendlerini saatlik yayımlar; kimlik istemez). Tweet'ler, X'in gündem haberleri
// (haberler.xml) ve trendlerin X'teki kategorisi bird CLI'yla (@steipete/bird, X'in web GraphQL'i, oturum çerezi) çekilir (Node 22).
//
// Ortam:  BASE_URL     yayımlanmış sitenin adresi; önceki durum BASE_URL/state.json'dan okunur (ilk görülme anları, çekilmiş tweet'ler).
//         OUT_DIR      çıktı klasörü (varsayılan: public).
//         AUTH_TOKEN, CT0   X oturum çerezleri (bird okur; yerelde BIRD_AUTH_TOKEN ve BIRD_CT0 de olur). Yoksa tweet, kategori ve
//                      haber çekilmez; trend listeleri yine yayımlanır, önceki tweet'ler korunur.
//         BIRD         bird komutu (varsayılan: bird).
// Yerel deneme:  node gundem.mjs [--prev eski/state.json] [--out klasor] [--budget 5] [--regions turkiye,abd]

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const REPO = 'https://github.com/hilmigundogdu/x-gundem-rss';
const USER_AGENT = `x-gundem-rss/1.0 (+${REPO})`;
const TRENDS24 = 'https://trends24.in/';
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const TOP = 10;                             // bölge başına beslemeye giren trend
const TWEETS = 5;                           // trend öğesindeki tweet
const MIN_TWEETS = 3;                       // ilk aramadan bundan az tweet gelirse dil süzgeci kalkar, beğeni eşiği onda birine iner
const SEARCH_BUDGET = 40;                   // bir çalışmadaki en çok arama (X'in arama sınırı hesap başına 15 dakikada ~50)
const SEARCH_GAP_MS = 2_000;                // aramalar arasındaki en kısa ara
const REFRESH_MS = 3 * HOUR;                // gündemde kalan trendin tweet'leri en çok bu sıklıkla yenilenir
const RETRY_MS = HOUR;                      // tweet bulunamayan trend bu süre sonra yeniden aranır
const KEEP_MS = DAY;                        // gündemden düşen trend son görülmesinden sonra bu kadar süre beslemede kalır
const MAX_ITEMS = 40;                       // bölge beslemesindeki en çok öğe
const NEWS_KEEP_MS = 3 * DAY;               // gündem haberi son görülmesinden sonra bu kadar süre kalır
const FETCH_TIMEOUT_MS = 30_000;
const BIRD_TIMEOUT_MS = 90_000;

// faves: ilk aramadaki beğeni eşiği; lang: X'in dil süzgeci (Dünya'da yok).
const REGIONS = [
  { slug: 'dunya', name: 'Dünya', where: 'Dünyada', path: '', lang: null, faves: 500 },
  { slug: 'abd', name: 'ABD', where: "ABD'de", path: 'united-states/', lang: 'en', faves: 500 },
  { slug: 'turkiye', name: 'Türkiye', where: "Türkiye'de", path: 'turkey/', lang: 'tr', faves: 100 },
  { slug: 'birlesik-krallik', name: 'Birleşik Krallık', where: "Birleşik Krallık'ta", path: 'united-kingdom/', lang: 'en', faves: 200 },
  { slug: 'almanya', name: 'Almanya', where: "Almanya'da", path: 'germany/', lang: 'de', faves: 100 },
  { slug: 'fransa', name: 'Fransa', where: "Fransa'da", path: 'france/', lang: 'fr', faves: 100 },
  { slug: 'ispanya', name: 'İspanya', where: "İspanya'da", path: 'spain/', lang: 'es', faves: 100 },
  { slug: 'italya', name: 'İtalya', where: "İtalya'da", path: 'italy/', lang: 'it', faves: 100 },
  { slug: 'hollanda', name: 'Hollanda', where: "Hollanda'da", path: 'netherlands/', lang: 'nl', faves: 50 },
];

const { values: args } = parseArgs({ options: {
  prev: { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' }, regions: { type: 'string' },
} });
const baseUrl = (process.env.BASE_URL || '').replace(/\/?$/, '/');
const outDir = args.out || process.env.OUT_DIR || 'public';
const budget = args.budget ? Number(args.budget) : SEARCH_BUDGET;
const regions = args.regions ? REGIONS.filter(r => args.regions.split(',').includes(r.slug)) : REGIONS;
if (!regions.length || !(budget >= 0)) { console.error('HATA: --regions ya da --budget geçersiz.'); process.exit(2); }
const BIRD = process.env.BIRD || 'bird';
const auth = { AUTH_TOKEN: process.env.AUTH_TOKEN || process.env.BIRD_AUTH_TOKEN || '', CT0: process.env.CT0 || process.env.BIRD_CT0 || '' };
const hasAuth = Boolean(auth.AUTH_TOKEN && auth.CT0);

// ---- Yardımcılar

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => e[0] !== '#' ? ENTITIES[e.toLowerCase()] ?? all
  : String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const esc = s => String(s).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = s => `<![CDATA[${String(s).replace(INVALID_XML, '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const keyOf = name => name.normalize('NFC').toLowerCase();
const searchUrl = name => `https://x.com/search?q=${encodeURIComponent(name)}&src=trend_click`;
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

// ---- Durum: önceki çalışmanın state.json'u; ilk görülme anlarını ve çekilmiş tweet'leri taşır.

const emptyState = () => ({ version: 1, regions: {}, tweets: {}, context: {}, news: {} });

async function loadState() {
  if (args.prev) return { ...emptyState(), ...JSON.parse(await readFile(args.prev, 'utf8')) };
  if (!process.env.BASE_URL) { console.log('BASE_URL yok; sıfırdan başlanıyor.'); return emptyState(); }
  const res = await get(`${baseUrl}state.json?t=${Date.now()}`);
  if (res.status === 404) { console.log('Önceki durum yok; sıfırdan başlanıyor.'); return emptyState(); }
  if (!res.ok) throw new Error(`Önceki durum okunamadı (HTTP ${res.status}); ilk görülme anları kaybolmasın diye yayın yapılmadı.`);
  return { ...emptyState(), ...JSON.parse(res.body) };
}

// ---- trends24: sayfadaki ilk liste en son anlık görüntüdür (saatlik).

function parseTrends24(html) {
  const head = /class=["']?title["']? data-timestamp=["']?([\d.]+)/.exec(html);
  const start = html.indexOf('trend-card__list', head?.index ?? 0);
  const end = html.indexOf('</ol>', start);
  if (!head || start < 0 || end < 0) throw new Error('trends24 sayfasında trend listesi bulunamadı.');
  const names = [...html.slice(start, end).matchAll(/<a\b[^>]*class=["']?trend-link["']?[^>]*>([^<]+)<\/a>/g)]
    .map(m => decode(m[1]).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!names.length) throw new Error('trends24 listesi boş.');
  return { at: Math.round(parseFloat(head[1]) * 1000), names: [...new Set(names)].slice(0, TOP) };
}

async function fetchTrends(region) {
  const res = await get(TRENDS24 + region.path);
  if (!res.ok) throw new Error(`trends24 HTTP ${res.status}`);
  return parseTrends24(res.body);
}

// ---- Tweet'ler: X'in "Latest" araması (bird "Top"u desteklemiyor) son TWEET_WINDOW_MS ve beğeni eşiğiyle süzülür, en beğenilenler alınır.
// Süre süzgeci olmasa yüksek eşikte günler önceki tweet'ler gelir.

const TWEET_WINDOW_MS = DAY;

function searchQuery(name, lang, faves) {
  const q = /^[#$]\S+$/.test(name) ? name : `"${name.replace(/"/g, '')}"`;
  const since = `since_time:${Math.floor((Date.now() - TWEET_WINDOW_MS) / 1000)}`;
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

async function searchTweets(name, lang, faves, use) {
  const found = new Map();
  const run = async query => {
    const list = await use(() => bird(['search', query, '-n', '20', '--json']));
    for (const t of Array.isArray(list) ? list : list?.tweets ?? []) if (t?.id && !found.has(String(t.id))) found.set(String(t.id), slim(t));
  };
  await run(searchQuery(name, lang, faves));
  // Gevşek arama bütçeye sığmazsa ilk aramanın sonucu yine kullanılır.
  if (found.size < MIN_TWEETS) await run(searchQuery(name, null, Math.max(1, Math.round(faves / 10)))).catch(e => { if (!e.budget || !found.size) throw e; });
  return [...found.values()].sort((a, b) => b.likes - a.likes).slice(0, TWEETS);
}

// ---- X'in kendi bağlamı: oturum hesabının konumundaki (Türkiye) trend sekmesinin kategorileri.

function contextOf(item) {
  if (/promoted_trend/.test(item.url ?? item.id ?? '')) return null;   // reklamlı trend
  const category = (item.category ?? '').replace(/\s*·\s*Trending$/, '').replace(/^Trending( in .*)?$/, '').trim();
  const description = (item.description ?? '').trim();
  return category || description ? { category, description } : null;
}

// ---- RSS

function renderTweet(t) {
  const body = esc(t.text).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>');
  const media = t.media.map(m => `<p><a href="${esc(tweetUrl(t))}"><img src="${esc(m.url)}" alt="${m.type === 'photo' ? '' : 'video'}"></a></p>`).join('');
  const quoted = t.quoted ? `<blockquote><p><b>${esc(t.quoted.name)}</b> (@${esc(t.quoted.user)})<br>${esc(t.quoted.text).replace(/\n/g, '<br>')}</p></blockquote>` : '';
  const video = t.media.some(m => m.video) ? ' · ▶ video' : '';
  return `<blockquote><p>${body}</p>${media}${quoted}</blockquote>\n`
    + `<p>— <b>${esc(t.name)}</b> (@${esc(t.user)}) · ${number(t.likes)} beğeni · ${number(t.retweets)} RT${video} · `
    + `<a href="${esc(tweetUrl(t))}">${t.at ? time(t.at) : 'tweet'}</a></p>`;
}

function trendItem(region, name, seen, tweets, context, now) {
  // Okuyucular özeti ilk satırlardan çıkardığı için önce bağlam ve tweet'ler, sıra bilgisi en sonda.
  const lines = [];
  if (context) lines.push(`<p><b>${esc(context.category || 'X')}</b>${context.description ? ` — ${esc(context.description)}` : ''}</p>`);
  if (tweets?.list.length) lines.push(...tweets.list.map(renderTweet));
  else lines.push(tweets ? '<p>Son 24 saatte beğeni eşiğini geçen tweet bulunamadı.</p>' : '<p>Tweet\'ler henüz çekilmedi.</p>');
  lines.push(seen.rank != null
    ? `<p><small>${esc(region.where)} ${seen.rank}. sırada · ilk görülme ${time(seen.firstSeen)}`
    : `<p><small>${esc(region.where)} gündemden düştü · son görülme ${time(seen.lastSeen)}, en iyi sıra ${seen.best}.`);
  lines[lines.length - 1] += `${tweets?.list.length ? ` · tweet'ler ${time(tweets.at)} itibarıyla` : ''} · <a href="${esc(searchUrl(name))}">X'te ara</a></small></p>`;
  return {
    title: name, link: searchUrl(name), guid: `x-gundem:${region.slug}:${keyOf(name)}`, date: seen.firstSeen,
    categories: [region.name, ...(context?.category ? [context.category] : [])], description: lines.join('\n'),
  };
}

function render(channel, items, now) {
  const date = ms => new Date(ms).toUTCString();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
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
      '</item>');
  }
  lines.push('</channel>', '</rss>', '');
  return lines.join('\n');
}

function indexHtml(files, now) {
  const rows = files.map(f => `<li><a href="${esc(f.file)}">${esc(f.title)}</a></li>`).join('\n');
  return `<!doctype html><meta charset="utf-8"><title>X gündem RSS</title>
<h1>X gündem RSS</h1><p>X trendleri bölge bölge, en beğenilen tweet'leriyle. Son üretim: ${time(now)} (İstanbul). <a href="${REPO}">Kaynak</a></p>
<ul>
${rows}
</ul>
`;
}

// ---- Çalışma

async function main() {
  const now = Date.now();
  const state = await loadState();
  if (!hasAuth) console.log('UYARI: X çerezleri yok; tweet, kategori ve haber çekilmeyecek.');

  // 1. Bölge trend listeleri.
  const current = new Map();   // slug -> isimler (sıralı)
  for (const region of regions) {
    const prev = state.regions[region.slug] ?? { at: 0, trends: {} };
    try {
      const { at, names } = await fetchTrends(region);
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
    } catch (e) {
      console.log(`${region.name}: trend listesi alınamadı (${e.message}); önceki liste yerinde kalıyor.`);
      state.regions[region.slug] = prev;
      current.set(region.slug, Object.values(prev.trends).filter(t => t.rank != null).sort((a, b) => a.rank - b.rank).map(t => t.name));
    }
    await sleep(500);
  }
  if (![...current.values()].some(n => n.length)) throw new Error('Hiçbir bölgenin trend listesi yok; yayın yapılmadı.');

  // Düşen ve süresi dolan trendler atılır.
  for (const slug of Object.keys(state.regions)) {
    const trends = state.regions[slug].trends;
    for (const [key, seen] of Object.entries(trends)) if (seen.rank == null && now - seen.lastSeen > KEEP_MS) delete trends[key];
  }

  if (hasAuth) {
    // 2. X'in trend sekmesindeki kategori ve açıklamalar (oturum hesabının konumu).
    try {
      const list = await bird(['trending', '--trending-only', '-n', '30', '--json']);
      let n = 0;
      for (const item of list) {
        const ctx = item.headline && contextOf(item);
        if (ctx) { state.context[keyOf(item.headline)] = { ...ctx, at: now }; n++; }
      }
      console.log(`X trend sekmesi: ${list.length} trend, ${n} bağlam.`);
    } catch (e) { console.log(`X trend sekmesi alınamadı: ${e.message}`); }

    // 3. X'in gündem haberleri.
    try {
      const list = await bird(['news', '--news-only', '-n', '20', '--json-full']);
      for (const item of list) {
        const id = /trending\/(\d+)/.exec(item.id ?? '')?.[1];
        if (!id || !item.headline) continue;
        const old = state.news[id];
        state.news[id] = {
          headline: item.headline, category: (item.category ?? '').replace(/^AI · /, ''), postCount: item.postCount ?? old?.postCount ?? null,
          image: item._raw?.images?.[0]?.url ?? item._raw?.thumbnail_image?.original_img_url ?? old?.image ?? null,
          firstSeen: old?.firstSeen ?? now, lastSeen: now,
        };
      }
      console.log(`X gündem haberleri: ${list.length}.`);
    } catch (e) { console.log(`X gündem haberleri alınamadı: ${e.message}`); }

    // 4. Tweet'ler: önce hiç çekilmemiş trendler (iyi sıradan başlayarak), sonra yenilenmesi gelenler. Bölgeler arasında ortak trend bir kez aranır.
    const want = new Map();
    for (const region of regions) (current.get(region.slug) ?? []).forEach((name, i) => {
      const key = keyOf(name), had = want.get(key);
      if (!had || i + 1 < had.rank) want.set(key, { name, region, rank: i + 1 });
    });
    const due = [...want].filter(([key]) => { const t = state.tweets[key]; return !t || now - t.at >= (t.list.length ? REFRESH_MS : RETRY_MS); })
      .sort(([ka, a], [kb, b]) => Number(Boolean(state.tweets[ka])) - Number(Boolean(state.tweets[kb])) || a.rank - b.rank);
    let searches = 0, done = 0, stop = false;
    const use = async call => {
      if (searches >= budget) throw Object.assign(new Error('arama bütçesi bitti'), { budget: true });
      if (searches) await sleep(SEARCH_GAP_MS);
      searches++;
      return call();
    };
    for (const [key, { name, region }] of due) {
      if (stop || searches >= budget) break;
      try {
        state.tweets[key] = { at: Date.now(), list: await searchTweets(name, region.lang, region.faves, use) };
        done++;
      } catch (e) {
        if (e.budget) break;
        console.log(`"${name}" aranamadı: ${e.message}`);
        if (rateLimited(e)) { console.log('X arama sınırına takıldı; aramalar sonraki çalışmaya kaldı.'); stop = true; }
      }
    }
    console.log(`Tweet: ${done}/${due.length} trend güncellendi, ${searches}/${budget} arama.`);
  }

  // Artık hiçbir beslemede olmayan tweet, bağlam ve haberler atılır.
  const live = new Set(Object.values(state.regions).flatMap(r => Object.keys(r.trends)));
  for (const key of Object.keys(state.tweets)) if (!live.has(key)) delete state.tweets[key];
  for (const [key, c] of Object.entries(state.context)) if (!live.has(key) && now - c.at > KEEP_MS) delete state.context[key];
  for (const [id, n] of Object.entries(state.news)) if (now - n.lastSeen > NEWS_KEEP_MS) delete state.news[id];

  // 5. Yazma.
  await mkdir(outDir, { recursive: true });
  const files = [];
  for (const region of REGIONS) {
    const trends = state.regions[region.slug]?.trends;
    if (!trends) continue;
    const items = Object.entries(trends)
      .sort(([, a], [, b]) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.lastSeen - a.lastSeen)
      .slice(0, MAX_ITEMS)
      .map(([key, seen]) => trendItem(region, seen.name, seen, state.tweets[key], state.context[key], now));
    const file = `${region.slug}.xml`, title = `X Trend · ${region.name}`;
    await writeFile(join(outDir, file), render({ file, title, link: `${TRENDS24}${region.path}`,
      description: `${region.where} X trendleri (trends24.in), her birinde en beğenilen tweet'ler.` }, items, now));
    files.push({ file, title });
  }
  const news = Object.entries(state.news).sort(([, a], [, b]) => b.lastSeen - a.lastSeen || b.firstSeen - a.firstSeen).map(([id, n]) => ({
    title: n.headline, link: `https://x.com/i/trending/${id}`, guid: `x-gundem:haber:${id}`, date: n.firstSeen,
    categories: ['X Gündem', ...(n.category ? [n.category] : [])],
    description: [`<p>${esc(n.category || 'Haber')}${n.postCount ? ` · ${compact(n.postCount)} gönderi` : ''} · ilk görülme ${time(n.firstSeen)}`
      + ` · <a href="https://x.com/i/trending/${id}">X'te aç</a></p>`, ...(n.image ? [`<p><img src="${esc(n.image)}" alt=""></p>`] : [])].join('\n'),
  }));
  await writeFile(join(outDir, 'haberler.xml'), render({ file: 'haberler.xml', title: 'X Gündem · Haberler', link: 'https://x.com/explore/tabs/news',
    description: "X'in Keşfet'teki gündem haberleri (oturum hesabının konumuna göre)." }, news, now));
  files.push({ file: 'haberler.xml', title: 'X Gündem · Haberler' });
  await writeFile(join(outDir, 'state.json'), JSON.stringify(state));
  await writeFile(join(outDir, 'index.html'), indexHtml(files, now));
  console.log(`Yazıldı: ${files.length} besleme → ${outDir}`);
}

main().catch(e => { console.error(`HATA: ${e.message}`); process.exit(1); });
