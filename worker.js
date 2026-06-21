/**
 * WRLD_NEWS edge proxy — Cloudflare Worker.
 *
 * Why this exists:
 *   The dashboard is 100% client-side, so without a proxy every visitor hits
 *   GDELT / the article reader directly and gets rate-limited (GDELT allows only
 *   ~1 request / 5s per IP). This Worker fetches once, caches at the edge, and
 *   shares the result across all visitors — per-visitor throttling disappears.
 *
 * Endpoints (all return permissive CORS):
 *   GET /gdelt?query=...&maxrecords=250   → GDELT ArtList JSON, edge-cached 10 min
 *   GET /extract?url=https://...          → readable article text, edge-cached 6 h
 *   GET /tle?group=active                 → CelesTrak GP TLE, edge-cached 2 h
 *   GET /satcat                           → CelesTrak SATCAT csv, edge-cached 24 h
 *
 * Why /tle and /satcat exist:
 *   CelesTrak rate-limits per IP: it returns HTTP 403 ("GP data has not updated
 *   since your last successful download") if the same GROUP is re-fetched inside
 *   its 2-hour refresh window. A browser reloading the page — or many visitors
 *   behind one IP — trips this constantly. The Worker fetches once, edge-caches,
 *   and serves everyone from cache, so the 403 never reaches the client.
 *
 * Deploy (free tier is plenty):
 *   1. npm i -g wrangler && wrangler login
 *   2. wrangler deploy            (uses wrangler.toml below, or `wrangler deploy worker.js`)
 *   3. Put the resulting https://<name>.<you>.workers.dev origin into
 *      index.html → const API_PROXY = 'https://<name>.<you>.workers.dev';
 *
 * Minimal wrangler.toml:
 *   name = "wrld-news"
 *   main = "worker.js"
 *   compatibility_date = "2024-11-01"
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/gdelt')   return await handleGdelt(url);
      if (url.pathname === '/extract') return await handleExtract(url);
      if (url.pathname === '/tle')     return await handleTle(url);
      if (url.pathname === '/satcat')  return await handleSatcat(url);
      if (url.pathname === '/' || url.pathname === '/health')
        return json({ ok: true, service: 'wrld-news proxy' });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502);
    }
    return json({ error: 'not found' }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── /gdelt ────────────────────────────────────────────────────────────────
// Edge-cached GDELT pass-through. The cache key is the normalized query, so all
// visitors asking the same thing share one upstream fetch.
async function handleGdelt(reqUrl) {
  const query = reqUrl.searchParams.get('query') || 'world OR politics';
  const maxrecords = Math.min(Number(reqUrl.searchParams.get('maxrecords')) || 250, 250);

  const upstream =
    'https://api.gdeltproject.org/api/v2/doc/doc' +
    `?query=${encodeURIComponent(query)}` +
    `&mode=ArtList&format=json&maxrecords=${maxrecords}&timespan=1d&sort=hybridrel`;

  const cache = caches.default;
  const cacheKey = new Request('https://cache/gdelt?q=' + encodeURIComponent(query) + '&n=' + maxrecords);
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const r = await fetch(upstream, { headers: { 'User-Agent': 'wrld-news/1.0' } });
  const text = await r.text();
  const trimmed = text.trim();
  // GDELT returns plain-text throttle notices with HTTP 200 — treat as error so
  // we never cache a bad payload.
  if (!trimmed.startsWith('{')) {
    return json({ error: 'gdelt throttled', detail: trimmed.slice(0, 120), articles: [] }, 429);
  }

  const resp = new Response(trimmed, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',   // 10 min at the edge
      ...CORS,
    },
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// ── /extract ──────────────────────────────────────────────────────────────
// Readable article text. Tries jina reader first, then a raw-HTML paragraph
// scrape. Edge-cached 6h because article bodies don't change.
async function handleExtract(reqUrl) {
  const target = reqUrl.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return json({ error: 'bad url' }, 400);

  const cache = caches.default;
  const cacheKey = new Request('https://cache/extract?u=' + encodeURIComponent(target));
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  let body = '';
  try {
    const r = await fetch('https://r.jina.ai/' + target, { headers: { Accept: 'text/plain' } });
    if (r.ok) {
      const t = await r.text();
      const i = t.indexOf('Markdown Content:');
      body = (i >= 0 ? t.slice(i + 'Markdown Content:'.length) : t).trim();
    }
  } catch (_) { /* fall through to raw scrape */ }

  if (body.length < 80) {
    try {
      const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (wrld-news)' } });
      const html = await r.text();
      body = scrapeParagraphs(html);
    } catch (_) { /* leave body empty */ }
  }

  if (body.length < 80) return json({ error: 'extraction failed' }, 422);

  const resp = new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=21600',  // 6h
      ...CORS,
    },
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// Very small readability heuristic: strip non-content tags, keep <p> blocks.
function scrapeParagraphs(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(cleaned))) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 60) paras.push(text);
  }
  return paras.join('\n\n').trim();
}

// ── /tle ────────────────────────────────────────────────────────────────────
// Edge-cached CelesTrak GP TLE pass-through. Cached 2h to match CelesTrak's own
// refresh cadence, which also keeps us under its per-IP repeat-download 403.
// `group` is allow-listed to alphanumerics + dash so it can't be used as an
// open proxy.
async function handleTle(reqUrl) {
  let group = (reqUrl.searchParams.get('group') || 'active').toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(group)) group = 'active';

  const upstream =
    `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;

  const cache = caches.default;
  const cacheKey = new Request('https://cache/tle?g=' + group);
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const r = await fetch(upstream, { headers: { 'User-Agent': 'wrld-news/1.0' } });
  const text = await r.text();
  // CelesTrak signals the per-IP repeat-download limit with a 403 + plain-text
  // body; only cache a payload that actually contains TLE lines.
  if (!/\b1 \d{5}/.test(text)) {
    return json({ error: 'celestrak unavailable', detail: text.slice(0, 120) }, 502);
  }

  const resp = new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=7200',   // 2h at the edge
      ...CORS,
    },
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// ── /satcat ───────────────────────────────────────────────────────────────
// Edge-cached SATCAT (NORAD_CAT_ID → OWNER). Changes rarely, so cache 24h.
async function handleSatcat() {
  const upstream = 'https://celestrak.org/pub/satcat.csv';
  const cache = caches.default;
  const cacheKey = new Request('https://cache/satcat');
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const r = await fetch(upstream, { headers: { 'User-Agent': 'wrld-news/1.0' } });
  const text = await r.text();
  if (!text.includes('NORAD_CAT_ID')) {
    return json({ error: 'satcat unavailable' }, 502);
  }

  const resp = new Response(text, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',  // 24h
      ...CORS,
    },
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

function withCors(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
}
