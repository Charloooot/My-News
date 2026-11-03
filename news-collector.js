/**
 * News collector — runs inside the Cloudflare Worker (imported by worker.js).
 *
 * Every 15 min (Cron Trigger) it pulls every source below in one pass, merges
 * them into a single normalized article list and stores it (KV if bound, else
 * the edge cache). Browsers then make ONE request to /news instead of each
 * hammering GDELT and getting throttled.
 *
 * Deliberately NOT done here: geolocation and story clustering. Those run in the
 * browser (index.html) so there's a single gazetteer, and so the fallback path
 * (direct GDELT, cached or demo news) gets the same treatment. The Worker stays
 * a thin, cheap collection layer — well within the free plan's CPU budget.
 *
 * Sources
 *   always on : 15 curated RSS feeds · ReliefWeb (RSS) · GDACS alerts · GDELT ×3
 *   optional  : The Guardian Open Platform  (secret GUARDIAN_KEY)
 *               ACLED conflict events        (secrets ACLED_USER + ACLED_PASS)
 *
 * Normalized article shape (GDELT-compatible field names, so the client's
 * existing pipeline keeps working):
 *   { title, url, domain, socialimage, seendate: 'YYYYMMDDTHHMMSSZ',
 *     sourcecountry, language, desc, src, kind: 'news'|'alert'|'event',
 *     countryHint?, lat?, lon?, severity?: 'critical'|'elevated'|'moderate' }
 */

const UA = 'wrld-news/1.0 (+news aggregator)';

// Feed → outlet country. `sourcecountry` is only the publisher's home; the
// client geolocates each story by what it is ABOUT and falls back to this.
export const RSS_FEEDS = [
  { id: 'bbc',        url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                  country: 'United Kingdom' },
  { id: 'guardian',   url: 'https://www.theguardian.com/world/rss',                        country: 'United Kingdom', skipIf: 'GUARDIAN_KEY' },
  { id: 'skynews',    url: 'https://feeds.skynews.com/feeds/rss/world.xml',                country: 'United Kingdom' },
  { id: 'aljazeera',  url: 'https://www.aljazeera.com/xml/rss/all.xml',                    country: 'Qatar' },
  { id: 'france24',   url: 'https://www.france24.com/en/rss',                              country: 'France' },
  { id: 'euronews',   url: 'https://www.euronews.com/rss?level=theme&name=news',           country: 'France' },
  { id: 'dw',         url: 'https://rss.dw.com/rdf/rss-en-world',                          country: 'Germany' },
  { id: 'npr',        url: 'https://feeds.npr.org/1004/rss.xml',                           country: 'United States' },
  { id: 'cbc',        url: 'https://www.cbc.ca/webfeed/rss/rss-world',                     country: 'Canada' },
  { id: 'abc-au',     url: 'https://www.abc.net.au/news/feed/2942460/rss.xml',             country: 'Australia' },
  { id: 'scmp',       url: 'https://www.scmp.com/rss/91/feed',                             country: 'Hong Kong' },
  { id: 'toi',        url: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms',   country: 'India' },
  { id: 'allafrica',  url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf', country: null },
  { id: 'mercopress', url: 'https://en.mercopress.com/rss/',                               country: 'Uruguay' },
  { id: 'un-news',    url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml',       country: null },
  { id: 'reliefweb',  url: 'https://reliefweb.int/updates/rss.xml',                        country: null, reliefweb: true },
];

// Three complementary GDELT slices (each ≤250). GDELT allows ~1 req / 5 s per
// IP, so they run sequentially with a gap — wall time in a cron is free.
export const GDELT_QUERIES = [
  '(world OR politics OR economy OR conflict OR treaty OR summit)',
  '(war OR attack OR airstrike OR killed OR protest OR coup OR ceasefire OR militants)',
  '(election OR sanctions OR minister OR president OR parliament OR diplomacy OR trade)',
];
const GDELT_GAP_MS = 6000;

const MAX_AGE_NEWS_H = 36;     // drop older RSS/GDELT items
// Recurring non-stories that clutter the wire (bulletins, quizzes, puzzles…).
const NOISE = /^(latest news bulletin|news ?bulletin|morning briefing|evening briefing|the briefing|quiz:|crossword|wordle|horoscope|podcast:|newsletter:)|\b(quiz of the week|picture of the day|photos of the day|in pictures:)\b/i;
const MAX_ARTICLES = 1800;

// ───────────────────────────────────────────────────────────────────────────
export async function collectNews(env = {}) {
  const started = Date.now();
  const report = {};
  const track = async (name, fn) => {
    try {
      const items = await fn();
      report[name] = { ok: true, count: items.length };
      return items;
    } catch (e) {
      report[name] = { ok: false, count: 0, error: String(e && e.message || e).slice(0, 160) };
      return [];
    }
  };

  // Everything except GDELT in parallel; GDELT runs its own paced sequence.
  const feeds = RSS_FEEDS.filter(f => !(f.skipIf && env[f.skipIf]));
  const parallel = [
    ...feeds.map(f => track('rss:' + f.id, () => fetchRss(f))),
    track('gdacs', fetchGdacs),
  ];
  if (env.GUARDIAN_KEY) parallel.push(track('guardian-api', () => fetchGuardian(env.GUARDIAN_KEY)));
  if (env.ACLED_USER && env.ACLED_PASS) parallel.push(track('acled', () => fetchAcled(env)));

  const gdelt = (async () => {
    const out = [];
    for (let i = 0; i < GDELT_QUERIES.length; i++) {
      if (i) await sleep(GDELT_GAP_MS);
      out.push(...await track('gdelt:' + (i + 1), () => fetchGdelt(GDELT_QUERIES[i])));
    }
    return out;
  })();

  const lists = await Promise.all([...parallel, gdelt]);
  const articles = mergeArticles(lists.flat());
  return {
    generated: new Date().toISOString(),
    tookMs: Date.now() - started,
    sources: report,
    count: articles.length,
    articles,
  };
}

// URL-level dedup (titles are clustered client-side), age cut-off, newest first.
function mergeArticles(all) {
  const cutoff = Date.now() - MAX_AGE_NEWS_H * 3600e3;
  const seen = new Set();
  const out = [];
  for (const a of all) {
    if (!a || !a.title || !a.url || NOISE.test(a.title)) continue;
    const key = canonicalUrl(a.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const t = gdeltDateToMs(a.seendate);
    // Alerts / events carry their own (longer) relevance window.
    if (a.kind === 'news' && t && t < cutoff) continue;
    out.push(a);
  }
  out.sort((x, y) => (gdeltDateToMs(y.seendate) || 0) - (gdeltDateToMs(x.seendate) || 0));
  return out.slice(0, MAX_ARTICLES);
}

// ── RSS / Atom ──────────────────────────────────────────────────────────────
// Workers have no DOMParser; feeds are regular enough for a tolerant regex pass.
async function fetchRss(feed) {
  const xml = await fetchText(feed.url, 15000);
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  if (!blocks.length) throw new Error('no items');
  const out = [];
  for (const b of blocks.slice(0, 60)) {
    const title = clean(tag(b, 'title'));
    const link = atomLink(b) || clean(tag(b, 'link')) || clean(tag(b, 'guid'));
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const rawDesc = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || '';
    const dateStr = clean(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated'));
    const ms = Date.parse(dateStr) || Date.now();
    const a = {
      title,
      url: link,
      domain: hostOf(link),
      socialimage: rssImage(b, rawDesc),
      seendate: msToGdeltDate(ms),
      sourcecountry: feed.country || '',
      language: 'English',
      desc: clip(stripHtml(decodeEntities(unCdata(rawDesc))), 320),
      src: 'rss:' + feed.id,
      kind: 'news',
    };
    if (feed.reliefweb) {
      // "Countries: Sudan, Chad" block, else the "Sudan: …" title prefix.
      const d = decodeEntities(unCdata(rawDesc));
      const m = d.match(/Countr(?:y|ies):\s*([^<]+)/i);
      const hint = m ? m[1].split(',')[0].trim() : (title.match(/^([^:]{3,40}):/) || [])[1];
      if (hint) a.countryHint = hint.trim();
      a.desc = clip(stripHtml(d.replace(/<div class="tag[\s\S]*?<\/div>/gi, '')), 320);
    }
    out.push(a);
  }
  return out;
}

function rssImage(block, rawDesc) {
  const pick = (re) => { const m = block.match(re); return m ? decodeEntities(m[1]) : ''; };
  return pick(/<media:content[^>]+url="([^"]+)"[^>]*(?:medium="image"|type="image)/i)
    || pick(/<media:thumbnail[^>]+url="([^"]+)"/i)
    || pick(/<media:content[^>]+url="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i)
    || pick(/<enclosure[^>]+url="([^"]+)"[^>]*type="image/i)
    || pick(/<enclosure[^>]+type="image[^"]*"[^>]*url="([^"]+)"/i)
    || (decodeEntities(unCdata(rawDesc || '')).match(/<img[^>]+src="([^"]+)"/i) || [])[1]
    || '';
}

// ── GDACS (UN/EC global disaster alerts) ───────────────────────────────────
async function fetchGdacs() {
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH'
    + '?alertlevel=Orange;Red&eventlist=EQ;TC;FL;VO;DR;WF'
    + `&fromdate=${day(Date.now() - 7 * 864e5)}&todate=${day(Date.now() + 864e5)}`;
  const j = JSON.parse(await fetchText(url, 20000));
  return (j.features || []).map(f => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    const link = p.url?.report || p.url?.details || `https://www.gdacs.org/report.aspx?eventtype=${p.eventtype}&eventid=${p.eventid}`;
    // `country` is a comma list for multi-country events (droughts); the first
    // one anchors the alert, the full list stays in the description.
    const countries = String(p.country || '').split(',').map(c => c.trim()).filter(Boolean);
    const where = countries[0] || p.affectedcountries?.[0]?.countryname || '';
    const name = p.name || p.eventname || 'disaster';
    const shortName = countries.length > 2 ? name.replace(/ in .*$/, ` in ${where} +${countries.length - 1} countries`) : name;
    return {
      title: `${p.alertlevel || ''} alert: ${shortName}${where && !shortName.includes(where) ? ' — ' + where : ''}`.trim(),
      url: link,
      domain: 'gdacs.org',
      socialimage: '',
      seendate: msToGdeltDate(Date.parse((p.datemodified || p.fromdate || '') + 'Z') || Date.now()),
      sourcecountry: '',
      language: 'English',
      desc: clip(stripHtml(p.htmldescription || p.description || '') + (p.severitydata?.severitytext ? ' · ' + p.severitydata.severitytext : ''), 320),
      src: 'gdacs',
      kind: 'alert',
      countryHint: where || undefined,
      lat: typeof lat === 'number' ? lat : undefined,
      lon: typeof lon === 'number' ? lon : undefined,
      severity: p.alertlevel === 'Red' ? 'critical' : 'elevated',
    };
  });
}

// ── GDELT DOC ArtList ──────────────────────────────────────────────────────
async function fetchGdelt(query) {
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc'
    + `?query=${encodeURIComponent(query)}&mode=ArtList&format=json&maxrecords=250&timespan=1d&sort=hybridrel`;
  let text;
  try {
    text = (await fetchText(url, 40000)).trim();
  } catch (e) {
    if (!/429/.test(String(e.message))) throw e;
    await sleep(12000);                                   // one polite retry
    text = (await fetchText(url, 40000)).trim();
  }
  if (!text.startsWith('{')) throw new Error('throttled: ' + text.slice(0, 80));
  const j = JSON.parse(text);
  return (j.articles || []).map(a => ({
    title: a.title, url: a.url, domain: a.domain, socialimage: a.socialimage || '',
    seendate: a.seendate, sourcecountry: a.sourcecountry || '', language: a.language || '',
    desc: '', src: 'gdelt', kind: 'news',
  }));
}

// ── The Guardian Open Platform (optional, free key) ─────────────────────────
// Keyword tags ("world/sudan") give a reliable subject country hint.
async function fetchGuardian(key) {
  const url = 'https://content.guardianapis.com/search?section=world&order-by=newest&page-size=50'
    + '&show-fields=trailText,thumbnail&show-tags=keyword&api-key=' + encodeURIComponent(key);
  const j = JSON.parse(await fetchText(url, 15000));
  return (j.response?.results || []).map(r => {
    const geoTag = (r.tags || []).find(t => /^world\/[a-z-]+$/.test(t.id) && t.type === 'keyword');
    return {
      title: r.webTitle, url: r.webUrl, domain: 'theguardian.com',
      socialimage: r.fields?.thumbnail || '',
      seendate: msToGdeltDate(Date.parse(r.webPublicationDate) || Date.now()),
      sourcecountry: 'United Kingdom', language: 'English',
      desc: clip(stripHtml(r.fields?.trailText || ''), 320),
      src: 'guardian', kind: 'news',
      countryHint: geoTag ? geoTag.webTitle : undefined,
    };
  });
}

// ── ACLED (optional, free account for non-commercial use) ──────────────────
// Raw ACLED is thousands of individual incidents; we roll them up per
// country × event type over the last 14 days (ACLED publishes with a lag) so
// they read as briefing-level signals instead of flooding the feed.
async function fetchAcled(env) {
  const tokRes = await fetch('https://acleddata.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({
      username: env.ACLED_USER, password: env.ACLED_PASS,
      grant_type: 'password', client_id: 'acled',
    }),
  });
  if (!tokRes.ok) throw new Error('acled auth ' + tokRes.status);
  const { access_token } = await tokRes.json();
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const url = 'https://acleddata.com/api/acled/read?_format=json&limit=5000'
    + `&event_date=${day(Date.now() - 14 * 864e5)}|${day(Date.now())}&event_date_where=BETWEEN`
    + '&fields=event_date|event_type|country|admin1|location|latitude|longitude|fatalities';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token, 'User-Agent': UA } });
  if (!r.ok) throw new Error('acled data ' + r.status);
  const rows = (await r.json()).data || [];

  const groups = new Map();
  for (const e of rows) {
    if (e.event_type === 'Strategic developments') continue;
    const k = e.country + '|' + e.event_type;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { country: e.country, type: e.event_type, n: 0, dead: 0, last: '', top: null });
    g.n++;
    const f = Number(e.fatalities) || 0;
    g.dead += f;
    if (e.event_date > g.last) g.last = e.event_date;
    if (!g.top || f > (Number(g.top.fatalities) || 0)) g.top = e;
  }
  return [...groups.values()]
    .sort((a, b) => (b.dead - a.dead) || (b.n - a.n))
    .slice(0, 80)
    .map(g => ({
      title: `${g.country}: ${g.n} ${g.type.toLowerCase()} in 14 days${g.dead ? `, ${g.dead} killed` : ''}`,
      url: `https://acleddata.com/dashboard/#/dashboard?country=${encodeURIComponent(g.country)}`,
      domain: 'acleddata.com', socialimage: '',
      seendate: msToGdeltDate(Date.parse(g.last + 'T12:00:00Z') || Date.now()),
      sourcecountry: '', language: 'English',
      desc: g.top ? `Most severe: ${g.top.location}, ${g.top.admin1} (${g.top.event_date}).` : '',
      src: 'acled', kind: 'event',
      countryHint: g.country,
      lat: g.top ? Number(g.top.latitude) : undefined,
      lon: g.top ? Number(g.top.longitude) : undefined,
      severity: g.dead >= 25 ? 'critical' : g.dead > 0 ? 'elevated' : 'moderate',
    }));
}

// ── helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function tag(block, name) {
  const re = new RegExp(`<${name.replace(':', '\\:')}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace(':', '\\:')}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}
function atomLink(block) {
  const m = block.match(/<link[^>]+rel="alternate"[^>]*href="([^"]+)"/i) || block.match(/<link[^>]+href="([^"]+)"/i);
  return m ? decodeEntities(m[1]) : '';
}
function unCdata(s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }
function clean(s) { return decodeEntities(unCdata(s)).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function clip(s, n) { return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function canonicalUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|at_|cmp|ito|ns_|fbclid|gclid|ocid)/i.test(k)) x.searchParams.delete(k);
    return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + (x.search || '')).toLowerCase();
  } catch { return u; }
}
const pad = (n) => String(n).padStart(2, '0');
export function msToGdeltDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function gdeltDateToMs(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}
