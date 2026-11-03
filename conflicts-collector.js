/**
 * Conflict intelligence — runs inside the Cloudflare Worker (imported by
 * worker.js), on its own cron so it never eats the news feed's subrequest
 * budget (50 per invocation on the free plan).
 *
 * Builds, for the CONFLICTS tab:
 *   history  — daily count of articles about each conflict, accumulated from
 *              our own merged /news feed (always available, grows by a day
 *              every day; deduplicated by URL hash across cron runs)
 *   gdelt    — 30-day daily article volume per conflict from the GDELT DOC
 *              timeline API. GDELT throttles hard (~1 req / 5 s / IP), so a
 *              few conflicts are refreshed per run, round-robin; failures keep
 *              the previous series
 *   acled    — georeferenced violent events (battles, explosions/remote
 *              violence, violence against civilians), last 14 days, for the
 *              countries of the tracked wars. Optional: needs the secrets
 *              ACLED_USER + ACLED_PASS (free non-commercial account)
 *   unhcr    — refugees / asylum-seekers / IDPs by country of origin
 *              (UNHCR Refugee Data Finder API, refreshed daily)
 *
 * Ids must match the CONFLICTS ids in index.html.
 */

const UA = 'wrld-news/1.0 (+news aggregator)';
const DAY_MS = 864e5;
const HISTORY_DAYS = 35;
const GDELT_PER_RUN = 4;
const GDELT_GAP_MS = 6000;
const UNHCR_TTL_MS = 24 * 3600e3;
const ACLED_TTL_MS = 6 * 3600e3;     // ACLED publishes weekly; no need to hammer it

// q: GDELT DOC query · kw: title pattern (any match) · pair: both patterns
// must match (+ a tension word) — for interstate rivalries where one country
// name alone is far too broad.
const TENSION = '\\b(war|military|troops|army|navy|missiles?|drones?|strikes?|attacks?|killed|clash\\w*|border|ceasefire|truce|talks|summit|sanctions?|tariffs?|nuclear|spy|drills?|threat\\w*|tensions?|retaliat\\w*|invasion|blockade|warships?|deal|negotiat\\w*|diplomat\\w*|hostages?|disputed?)\\b';
export const CONFLICT_TRACK = [
  { id: 'ru-ua', q: '(Ukraine OR Kyiv OR Donbas OR Zelensky)', kw: '\\b(Ukrain\\w*|Kyiv|Donbas|Donetsk|Zaporizh\\w*|Kharkiv|Zelensk\\w*|Pokrovsk)\\b' },
  { id: 'il-ps', q: '(Gaza OR Hamas OR "West Bank")', kw: '\\b(Gaza\\w*|Hamas|West Bank|Rafah|hostages?)\\b' },
  { id: 'il-ir', q: 'Israel Iran', pair: ['\\b(Israel\\w*|Netanyahu|IDF)\\b', '\\b(Iran\\w*|Tehran|Khamenei)\\b'] },
  { id: 'il-lb', q: '(Hezbollah OR Lebanon)', kw: '\\b(Hezbollah|Lebanon|Lebanese|Beirut)\\b' },
  { id: 'cn-tw', q: '(Taiwan OR "Taiwan Strait")', kw: '\\b(Taiwan\\w*|Taipei)\\b' },
  { id: 'cn-in', q: 'China India border', pair: ['\\b(China|Chinese|Beijing)\\b', '\\b(India\\w*|Delhi|Modi|Ladakh)\\b'] },
  { id: 'cn-jp', q: '(Senkaku OR "China Japan")', pair: ['\\b(China|Chinese|Beijing)\\b', '\\b(Japan\\w*|Tokyo|Takaichi|Senkaku)\\b'] },
  { id: 'cn-ph', q: '("South China Sea" OR Scarborough OR Spratly)', kw: '\\b(South China Sea|Scarborough|Spratly|Second Thomas)\\b' },
  { id: 'in-pk', q: '(Kashmir OR "Line of Control")', kw: '\\b(Kashmir\\w*|Line of Control|Operation Sindoor)\\b', pair: ['\\b(India\\w*|Delhi)\\b', '\\b(Pakistan\\w*|Islamabad)\\b'] },
  { id: 'kp-kr', q: '("North Korea" OR Pyongyang)', kw: '\\b(North Korea\\w*|Pyongyang|DMZ|Kim Jong Un)\\b' },
  { id: 'us-cn', q: 'China tariffs', pair: ['\\b(US|U\\.S\\.|United States|America\\w*|Washington|Trump)\\b', '\\b(China|Chinese|Beijing|Xi)\\b'] },
  { id: 'us-ru', q: 'Russia sanctions', pair: ['\\b(US|U\\.S\\.|United States|Washington|Trump)\\b', '\\b(Russia\\w*|Moscow|Kremlin|Putin)\\b'] },
  { id: 'us-ir', q: 'Iran Washington', pair: ['\\b(US|U\\.S\\.|United States|Washington|Trump)\\b', '\\b(Iran\\w*|Tehran|Khamenei)\\b'] },
  { id: 'us-kp', q: 'Pyongyang Washington', pair: ['\\b(US|U\\.S\\.|United States|Washington|Trump)\\b', '\\b(North Korea\\w*|Pyongyang|Kim Jong Un)\\b'] },
  { id: 'us-ve', q: '(Venezuela OR Maduro)', kw: '\\b(Venezuela\\w*|Maduro|Caracas)\\b' },
  { id: 'am-az', q: '(Armenia OR Azerbaijan OR Karabakh)', kw: '\\b(Armenia\\w*|Azerbaijan\\w*|Karabakh)\\b' },
  { id: 've-gy', q: 'Essequibo', kw: '\\b(Essequibo|Guyana\\w*)\\b' },
  { id: 'et-eg', q: '(GERD OR "Renaissance Dam")', kw: '\\b(GERD|Renaissance Dam|Nile dam)\\b' },
  { id: 'gr-tr', q: 'Greece Turkey', pair: ['\\b(Greece|Greek|Athens)\\b', '\\b(Turkey|Turkish|T[uü]rkiye|Ankara|Erdogan)\\b'] },
  { id: 'ma-dz', q: '("Western Sahara" OR Polisario)', kw: '\\b(Western Sahara|Polisario|Sahrawi)\\b' },
  { id: 'sa-ir', q: 'Saudi Iran', pair: ['\\b(Saudi\\w*|Riyadh)\\b', '\\b(Iran\\w*|Tehran)\\b'] },
  { id: 'tr-cy', q: 'Cyprus Turkey', pair: ['\\b(Cyprus|Cypriot|Nicosia)\\b', '\\b(Turkey|Turkish|T[uü]rkiye|Ankara)\\b'] },
  { id: 'rs-xk', q: 'Kosovo Serbia', kw: '\\b(Kosovo\\w*|Pristina)\\b' },
  { id: 'th-kh', q: 'Thailand Cambodia', pair: ['\\b(Thai\\w*|Bangkok)\\b', '\\b(Cambodia\\w*|Phnom Penh)\\b'] },
  { id: 'pk-af', q: 'Pakistan Afghanistan', pair: ['\\b(Pakistan\\w*|Islamabad)\\b', '\\b(Afghan\\w*|Taliban|Kabul)\\b'] },
  { id: 'cd-rw', q: '(M23 OR Goma OR "North Kivu" OR "South Kivu")', kw: '\\b(M23|Goma|Bukavu|Uvira|North Kivu|South Kivu)\\b' },
  { id: 'il-ye', q: '(Houthi OR Houthis)', kw: '\\b(Houthis?|Hodeidah|Sanaa|Red Sea shipping)\\b' },
  { id: 'sd',    q: '(Sudan OR Darfur OR "El Fasher")', kw: '(?<!South )\\b(Sudan(?:ese)?|Darfur|RSF|El Fasher|Khartoum|Kordofan)\\b' },
  { id: 'mm',    q: '(Myanmar OR Rakhine)', kw: '\\b(Myanmar|Burm\\w+|Rakhine|Arakan Army)\\b' },
  { id: 'sahel', q: '(Mali OR "Burkina Faso" OR JNIM OR Sahel)', kw: '\\b(Mali(?:an)?|Burkina\\w*|Niger(?!ia)\\w*|Sahel|JNIM|Bamako)\\b' },
  { id: 'ht',    q: '(Haiti OR "Port-au-Prince")', kw: '\\b(Haiti\\w*|Port-au-Prince)\\b' },
  { id: 'so',    q: '(al-Shabaab OR Somalia)', kw: '\\b(al-Shabaab|Al-Shabaab|Somali\\w*|Mogadishu)\\b' },
  { id: 'sy',    q: '(Syria OR Damascus)', kw: '\\b(Syria\\w*|Damascus|Aleppo|Sweida|al-Sharaa)\\b' },
  { id: 'ng',    q: '("Boko Haram" OR ISWAP OR Borno OR Zamfara)', kw: '\\b(Boko Haram|ISWAP|Borno|Zamfara|Nigeria\\w*)\\b' },
  { id: 'mx',    q: '(cartel OR Sinaloa OR CJNG)', kw: '\\b(cartels?|Sinaloa|CJNG|Culiac[aá]n)\\b' },
];

// ACLED country names whose violent events the CONFLICTS tab can show.
export const ACLED_COUNTRIES = ['Ukraine', 'Russia', 'Palestine', 'Israel', 'Lebanon', 'Yemen', 'Democratic Republic of Congo',
  'Sudan', 'Myanmar', 'Mali', 'Burkina Faso', 'Niger', 'Haiti', 'Somalia', 'Syria', 'Nigeria', 'Mexico', 'Pakistan',
  'Afghanistan', 'Thailand', 'Cambodia', 'Armenia', 'Azerbaijan', 'Venezuela'];
const ACLED_TYPES = { 'Battles': 0, 'Explosions/Remote violence': 1, 'Violence against civilians': 2 };

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function hash(s) {                 // FNV-1a → base36, enough to dedupe URLs
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
function gdeltDateToMs(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : NaN;
}

const matchers = CONFLICT_TRACK.map(t => ({
  id: t.id,
  kw: t.kw ? new RegExp(t.kw, 'i') : null,
  pair: t.pair ? t.pair.map(p => new RegExp(p)) : null,
}));
const TENSION_RE = new RegExp(TENSION, 'i');
function conflictIdsFor(title) {
  const out = [];
  for (const m of matchers) {
    if ((m.kw && m.kw.test(title)) || (m.pair && m.pair[0].test(title) && m.pair[1].test(title) && TENSION_RE.test(title))) out.push(m.id);
  }
  return out;
}

/**
 * @param env       Worker env (NEWS KV, ACLED_* secrets)
 * @param previous  last stored conflicts payload (or null)
 */
export async function collectConflicts(env = {}, previous = null) {
  const started = Date.now();
  const report = {};
  const prev = previous || {};
  const now = Date.now();
  const keepDays = new Set(Array.from({ length: HISTORY_DAYS }, (_, i) => dayKey(now - i * DAY_MS)));

  // ── 1. Own history from the merged world feed ──────────────────────────
  const history = {};
  for (const [id, days] of Object.entries(prev.history || {})) {
    history[id] = Object.fromEntries(Object.entries(days).filter(([d]) => keepDays.has(d)));
  }
  let seen = {};
  try { seen = (env.NEWS && JSON.parse(await env.NEWS.get('conflicts:seen') || '{}')) || {}; } catch {}
  // Only today's and yesterday's hash sets are kept: older days are frozen.
  const liveDays = new Set([dayKey(now), dayKey(now - DAY_MS)]);
  seen = Object.fromEntries(Object.entries(seen).filter(([d]) => liveDays.has(d)));
  try {
    const txt = env.NEWS ? await env.NEWS.get('news:latest') : null;
    const feed = txt ? JSON.parse(txt) : null;
    let n = 0;
    for (const a of feed?.articles || []) {
      if (a.kind === 'alert' || a.kind === 'event') continue;
      const ms = gdeltDateToMs(a.seendate);
      if (!Number.isFinite(ms)) continue;
      const d = dayKey(ms);
      if (!liveDays.has(d)) continue;
      const ids = conflictIdsFor(`${a.title || ''}`);
      if (!ids.length) continue;
      const h = hash(String(a.url || a.title));
      const daySeen = seen[d] || (seen[d] = {});
      for (const id of ids) {
        const set = daySeen[id] || (daySeen[id] = []);
        if (set.includes(h)) continue;
        set.push(h);
        (history[id] ||= {})[d] = (history[id][d] || 0) + 1;
        n++;
      }
    }
    report.history = { ok: !!feed, count: n };
  } catch (e) { report.history = { ok: false, count: 0, error: String(e.message || e).slice(0, 160) }; }

  // ── 2. GDELT 30-day timelines, a few per run ───────────────────────────
  const gdelt = { ...(prev.gdelt || {}) };
  let cursor = Number(prev.cursor) || 0;
  let gOk = 0, gErr = '';
  for (let i = 0; i < GDELT_PER_RUN; i++) {
    const t = CONFLICT_TRACK[cursor % CONFLICT_TRACK.length];
    cursor = (cursor + 1) % CONFLICT_TRACK.length;
    if (i) await sleep(GDELT_GAP_MS);
    try {
      gdelt[t.id] = { fetched: new Date().toISOString(), days: await fetchGdeltTimeline(t.q) };
      gOk++;
    } catch (e) { gErr = String(e.message || e).slice(0, 160); }
  }
  report.gdelt = { ok: gOk > 0, count: gOk, ...(gErr ? { error: gErr } : {}) };

  // ── 3. ACLED events (optional) ─────────────────────────────────────────
  let acled = prev.acled || null;
  if (env.ACLED_USER && env.ACLED_PASS) {
    if (!acled || now - Date.parse(acled.updated || 0) > ACLED_TTL_MS) {
      try { acled = await fetchAcledEvents(env); report.acled = { ok: true, count: acled.events.length }; }
      catch (e) { report.acled = { ok: false, count: acled?.events?.length || 0, carried: !!acled, error: String(e.message || e).slice(0, 160) }; }
    } else report.acled = { ok: true, count: acled.events.length, cached: true };
  } else {
    acled = null;
    report.acled = { ok: false, count: 0, error: 'not configured (wrangler secret put ACLED_USER / ACLED_PASS)' };
  }

  // ── 4. UNHCR displacement figures (daily) ──────────────────────────────
  let unhcr = prev.unhcr || null;
  if (!unhcr || now - Date.parse(unhcr.updated || 0) > UNHCR_TTL_MS) {
    try { unhcr = await fetchUnhcr(); report.unhcr = { ok: true, count: Object.keys(unhcr.byIso).length }; }
    catch (e) { report.unhcr = { ok: false, count: 0, carried: !!unhcr, error: String(e.message || e).slice(0, 160) }; }
  } else report.unhcr = { ok: true, count: Object.keys(unhcr.byIso).length, cached: true };

  if (env.NEWS) { try { await env.NEWS.put('conflicts:seen', JSON.stringify(seen)); } catch {} }

  return {
    generated: new Date().toISOString(),
    tookMs: Date.now() - started,
    sources: report,
    count: Object.keys(history).length + Object.keys(gdelt).length,
    cursor,
    history, gdelt, acled, unhcr,
  };
}

// GDELT DOC timeline → { 'YYYY-MM-DD': articles }. Resolution depends on the
// span (hourly/daily), so values are summed per UTC day.
async function fetchGdeltTimeline(query) {
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=timelinevolraw&timespan=30d&query=' + encodeURIComponent(query);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!r.ok) throw new Error('gdelt http ' + r.status);
    const txt = await r.text();
    if (!txt.trim().startsWith('{')) throw new Error('gdelt: ' + txt.slice(0, 60));   // throttle notice is plain text
    const series = JSON.parse(txt).timeline?.[0]?.data || [];
    if (!series.length) throw new Error('gdelt: empty timeline');
    const days = {};
    for (const p of series) {
      const ms = gdeltDateToMs(p.date);
      if (!Number.isFinite(ms)) continue;
      const d = dayKey(ms);
      days[d] = (days[d] || 0) + (Number(p.value) || 0);
    }
    return days;
  } finally { clearTimeout(timer); }
}

// ACLED: violent events of the last 14 days in ACLED_COUNTRIES, compacted to
// [lat, lon, 'YYYY-MM-DD', type (0 battle · 1 explosion · 2 vs civilians), fatalities, country, place].
async function fetchAcledEvents(env) {
  const tokRes = await fetch('https://acleddata.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ username: env.ACLED_USER, password: env.ACLED_PASS, grant_type: 'password', client_id: 'acled' }),
  });
  if (!tokRes.ok) throw new Error('acled auth ' + tokRes.status);
  const { access_token } = await tokRes.json();
  const from = dayKey(Date.now() - 14 * DAY_MS), to = dayKey(Date.now());
  const url = 'https://acleddata.com/api/acled/read?_format=json&limit=20000'
    + `&event_date=${from}|${to}&event_date_where=BETWEEN`
    + '&country=' + ACLED_COUNTRIES.map(encodeURIComponent).join(':OR:country=')
    + '&fields=event_date|event_type|country|admin1|location|latitude|longitude|fatalities';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token, 'User-Agent': UA } });
  if (!r.ok) throw new Error('acled data ' + r.status);
  const rows = (await r.json()).data || [];
  const keep = new Set(ACLED_COUNTRIES);
  const events = [];
  for (const e of rows) {
    const t = ACLED_TYPES[e.event_type];
    if (t === undefined || !keep.has(e.country)) continue;
    const lat = Number(e.latitude), lon = Number(e.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    events.push([+lat.toFixed(2), +lon.toFixed(2), e.event_date, t, Number(e.fatalities) || 0, e.country,
      [e.location, e.admin1].filter(Boolean).join(', ').slice(0, 60)]);
  }
  // Deadliest first, so a client cap keeps the events that matter.
  events.sort((a, b) => (b[4] - a[4]) || (a[2] < b[2] ? 1 : -1));
  return { updated: new Date().toISOString(), from, to, events: events.slice(0, 8000) };
}

// UNHCR totals by country of origin. Tries the current year, then the one
// before (figures are published with a lag).
async function fetchUnhcr() {
  const y = new Date().getUTCFullYear();
  for (const year of [y, y - 1, y - 2]) {
    const r = await fetch(`https://api.unhcr.org/population/v1/population/?limit=400&yearFrom=${year}&yearTo=${year}&coo_all=true`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error('unhcr http ' + r.status);
    const items = (await r.json()).items || [];
    if (!items.length) continue;
    const num = (v) => Number(v) || 0;
    const byIso = {};
    for (const it of items) {
      if (!/^[A-Z]{3}$/.test(it.coo_iso || '')) continue;
      byIso[it.coo_iso] = { refugees: num(it.refugees), asylum: num(it.asylum_seekers), idps: num(it.idps), name: it.coo_name };
    }
    return { updated: new Date().toISOString(), year, byIso };
  }
  throw new Error('unhcr: no data');
}
