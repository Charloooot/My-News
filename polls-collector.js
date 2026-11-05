/**
 * Voting-intention data for the POLITICS tab, built by the Cron Trigger.
 *
 * Source: English Wikipedia, whose editors tabulate every published poll with
 * a link back to the pollster. Wikitext is parsed rather than HTML because it
 * is far smaller, which matters for the free plan's CPU limit.
 *
 * Each country is collected on its own: when a page cannot be parsed (an
 * editor reshaped a table, a figure fails the sanity checks) that half keeps
 * its previous copy and the failure is reported in `sources`.
 */

const UA = 'WRLD_NEWS/1.0 (https://github.com/Charloooot/My-News)';
const API = 'https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2';
const FR_PAGE = 'Opinion_polling_for_the_2027_French_presidential_election';
const HOUSE_PAGE = '2026_United_States_House_of_Representatives_elections';
const SENATE_PAGE = '2026_United_States_Senate_elections';
const APPROVAL_PAGE = 'Opinion_polling_on_the_second_Trump_presidency';

const WINDOW_DAYS = 30;
const DAY_MS = 86400e3;
// A trend needs this many polls on each side: one poll would be noise.
const MIN_DELTA_POLLS = 3;

async function wikiParse(page, extra) {
  const r = await fetch(`${API}&page=${page}&${extra}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`wikipedia http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error('wikipedia: ' + j.error.code);
  return j.parse;
}
const pageUrl = (page) => 'https://en.wikipedia.org/wiki/' + page;
async function wikiLead(page) {
  return (await wikiParse(page, 'prop=wikitext&section=0')).wikitext;
}
async function wikiSection(page, heading) {
  const { sections } = await wikiParse(page, 'prop=sections');
  const s = sections.find(x => heading.test(x.line));
  if (!s) throw new Error('section not found: ' + heading);
  return (await wikiParse(page, `prop=wikitext&section=${s.index}`)).wikitext;
}

// ── Wikitext tables ─────────────────────────────────────────────────────────
function stripMarkup(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{\s*efn[\s\S]*?\}\}/gi, '');
}
// Splits on `sep` while outside [[links]], {{templates}} and [external links].
function splitTop(s, sep) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; cur += two; i++; continue; }
    if (two === ']]' || two === '}}') { depth = Math.max(0, depth - 1); cur += two; i++; continue; }
    if (depth === 0 && s.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out;
}
function parseCell(raw) {
  const parts = splitTop(raw, '|');
  // `style="…" | value` or `{{Party shading/…}} | value`: the part before the pipe is attributes.
  const hasAttrs = parts.length > 1 && /^\s*(?:[a-z-]+\s*=|;|\{\{\s*party shading)/i.test(parts[0]);
  const attrs = hasAttrs ? parts[0] : '';
  const text = (hasAttrs ? parts.slice(1).join('|') : raw).trim();
  const colspan = +(/colspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1] || 1);
  return { text, colspan };
}
// → [{ cells: [{text, colspan}], heads: [string] }] for one `{| … |}` table.
function parseRows(table) {
  const rows = [];
  for (const block of table.split(/^\|-.*$/m).slice(1)) {
    const cells = [], heads = [];
    const logical = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('|}')) continue;
      if (line.startsWith('|') || line.startsWith('!')) logical.push(line);
      else if (logical.length) logical[logical.length - 1] += ' ' + line;   // wrapped cell
    }
    for (const line of logical) {
      if (line.startsWith('!')) { heads.push(line.slice(1)); continue; }
      for (const c of splitTop(line.slice(1), '||')) cells.push(parseCell(c));
    }
    rows.push({ cells, heads });
  }
  return rows;
}
function tablesOf(text) {
  return [...text.matchAll(/^\{\|[\s\S]*?^\|\}/gm)].map(m => m[0]);
}
const plain = (s) => s.replace(/'''?/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
  .replace(/\[https?:\S+\s+([^\]]*)\]/g, '$1').replace(/<[^>]+>/g, ' ').trim();
// "18%" → 18 · "<0.5%" → 0.25 · "–" → null (not tested in that poll)
function parsePct(s) {
  const t = plain(s);
  if (/^<\s*[\d.]+/.test(t)) return parseFloat(t.replace(/[<\s]/g, '')) / 2;
  const m = /^(\d+(?:\.\d+)?)\s*%?/.exec(t);
  return m ? parseFloat(m[1]) : null;
}

// ── France: first round of the 2027 presidential election ───────────────────
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// {{Opdrts|27|29|Oct|2026|year}} · {{Opdrts||15|Oct|2026|year}} → end of fieldwork (ms)
function parseFieldworkEnd(cell) {
  const m = /\{\{\s*Opdrts\s*\|([^}]*)\}\}/i.exec(cell);
  if (!m) return null;
  const parts = m[1].split('|').map(x => x.trim());
  const y = parts.findIndex(p => /^\d{4}$/.test(p));
  if (y < 2) return null;
  const month = MONTHS[parts[y - 1].slice(0, 3).toLowerCase()];
  const day = +parts[y - 2];
  if (month == null || !day) return null;
  return Date.UTC(+parts[y], month, day);
}
// Only each poll's first row counts: it is the pollster's main scenario, the
// rows below it test alternative line-ups.
export function parseFrenchPolls(wikitext) {
  const polls = [];
  for (const table of tablesOf(stripMarkup(wikitext))) {
    const names = [...table.matchAll(/vert header[^\n]*?\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g)].map(m => m[1].trim());
    if (!names.length) continue;
    for (const { cells } of parseRows(table)) {
      if (cells.length < 4) continue;
      const end = parseFieldworkEnd(cells[1].text);
      if (end == null) continue;
      const values = {};
      let col = 0, used = 0;
      for (const c of cells.slice(3)) {
        const v = parsePct(c.text);
        if (c.colspan === 1 && v != null && col < names.length) { values[names[col]] = v; used++; }
        col += c.colspan;
      }
      if (used >= 3) polls.push({ firm: plain(cells[0].text), end, n: parseInt(plain(cells[2].text).replace(/\D/g, ''), 10) || null, values });
    }
  }
  return polls.sort((a, b) => b.end - a.end);
}
function averageWindow(polls, from, to) {
  const inWin = polls.filter(p => p.end > from && p.end <= to);
  const acc = new Map();
  for (const p of inWin) for (const [k, v] of Object.entries(p.values)) {
    const a = acc.get(k) || { sum: 0, n: 0 };
    a.sum += v; a.n++; acc.set(k, a);
  }
  return { count: inWin.length, acc };
}
// One poll, one vote; a candidate is averaged over the polls that tested them.
export function summarizeFrance(polls) {
  if (polls.length < 3) throw new Error(`only ${polls.length} French polls parsed`);
  const latest = polls[0].end;
  const cur = averageWindow(polls, latest - WINDOW_DAYS * DAY_MS, latest);
  const prev = averageWindow(polls, latest - 2 * WINDOW_DAYS * DAY_MS, latest - WINDOW_DAYS * DAY_MS);
  const round1 = (x) => Math.round(x * 10) / 10;
  const candidates = [...cur.acc.entries()]
    // Tested in under a third of the polls: too thin an average to display.
    .filter(([, a]) => a.n >= Math.max(1, cur.count / 3))
    .map(([name, a]) => {
      const p = prev.acc.get(name);
      const pct = round1(a.sum / a.n);
      return { name, pct, polls: a.n, delta: p && p.n >= MIN_DELTA_POLLS && a.n >= MIN_DELTA_POLLS ? round1(pct - p.sum / p.n) : null };
    });
  if (!candidates.length) throw new Error('no French candidate survived filtering');
  return {
    candidates,
    pollCount: cur.count,
    windowDays: WINDOW_DAYS,
    latestFieldwork: new Date(latest).toISOString().slice(0, 10),
    recent: polls.slice(0, 5).map(p => ({ firm: p.firm, end: new Date(p.end).toISOString().slice(0, 10), n: p.n })),
    source: pageUrl(FR_PAGE),
  };
}

// ── USA: midterm results, generic ballot, presidential approval ─────────────
function infoboxField(text, name) {
  const m = new RegExp(`^\\|\\s*${name}\\s*=(.*)$`, 'm').exec(text);
  return m ? stripMarkup(m[1]).trim() : '';
}
// "'''52–54'''" → 52: the seats already called, the low end of the range.
function seatsLow(s) {
  const m = /(\d+)/.exec(plain(s));
  return m ? +m[1] : null;
}
export function parseHouse(lead) {
  const f = (n) => seatsLow(infoboxField(lead, n));
  const d = f('seats_after1') ?? f('seats1');
  const r = f('seats_after2') ?? f('seats2');
  const total = 435;
  if (d == null || r == null || d + r > total) throw new Error('implausible House seats');
  return { dem: d, rep: r, other: 0, tbd: total - d - r, total, majority: 218, before: { dem: f('seats_before1'), rep: f('seats_before2') },
    updated: plain(infoboxField(lead, 'last_update')) || null, source: pageUrl(HOUSE_PAGE) };
}
export function parseSenate(lead) {
  const f = (n) => seatsLow(infoboxField(lead, n));
  const d = f('seats_after1') ?? f('seats1');
  const r = f('seats_after2') ?? f('seats2');
  // The Democrats' figure leaves out the independents who caucus with them.
  const ind = (f('seats_after3') || 0) + (f('seats_after4') || 0);
  const total = 100;
  if (d == null || r == null || d + r + ind > total) throw new Error('implausible Senate seats');
  return { dem: d, rep: r, other: ind, tbd: total - d - r - ind, total, majority: 51, before: { dem: f('seats_before1'), rep: f('seats_before2') }, source: pageUrl(SENATE_PAGE) };
}
const mean = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10;
// Aggregators only: the "Average" row is recomputed so a stale one cannot leak.
function aggregatorRows(table) {
  return parseRows(table).filter(r => r.cells.length >= 4 && !/average/i.test(plain(r.cells[0].text)) && !/^\s*$/.test(r.cells[0].text));
}
export function parseGenericBallot(section) {
  const table = tablesOf(stripMarkup(section))[0];
  if (!table) throw new Error('generic ballot table missing');
  const rows = aggregatorRows(table).map(r => ({
    name: plain(r.cells[0].text), updated: plain(r.cells[2].text),
    rep: parsePct(r.cells[3].text), dem: parsePct(r.cells[4].text),
  })).filter(r => r.rep != null && r.dem != null);
  if (rows.length < 2 || rows.some(r => r.rep + r.dem > 100)) throw new Error('implausible generic ballot');
  return { dem: mean(rows.map(r => r.dem)), rep: mean(rows.map(r => r.rep)), updated: rows[0].updated, aggregators: rows, source: pageUrl(HOUSE_PAGE) };
}
export function parseApproval(section) {
  const start = section.search(/^=+\s*Approval\s*=+\s*$/m);
  const table = tablesOf(stripMarkup(start >= 0 ? section.slice(start) : section))[0];
  if (!table) throw new Error('approval table missing');
  const rows = aggregatorRows(table).map(r => ({
    name: plain(r.cells[0].text), asOf: plain(r.cells[1].text),
    approve: parsePct(r.cells[2].text), disapprove: parsePct(r.cells[3].text),
  })).filter(r => r.approve != null && r.disapprove != null);
  if (rows.length < 2 || rows.some(r => r.approve + r.disapprove > 100)) throw new Error('implausible approval');
  return { approve: mean(rows.map(r => r.approve)), disapprove: mean(rows.map(r => r.disapprove)), asOf: rows[0].asOf, aggregators: rows, source: pageUrl(APPROVAL_PAGE) };
}

// ── Collector ───────────────────────────────────────────────────────────────
async function collectFrenchPart() {
  return summarizeFrance(parseFrenchPolls(await wikiSection(FR_PAGE, /^First round$/i)));
}
async function collectUsPart() {
  const [houseLead, senateLead, ballot, approval] = await Promise.all([
    wikiLead(HOUSE_PAGE), wikiLead(SENATE_PAGE),
    wikiSection(HOUSE_PAGE, /^Generic congressional ballot/i),
    wikiSection(APPROVAL_PAGE, /^Aggregate polls$/i),
  ]);
  return { house: parseHouse(houseLead), senate: parseSenate(senateLead), genericBallot: parseGenericBallot(ballot), approval: parseApproval(approval) };
}
export async function collectPolls(env = {}, previous = null) {
  const started = Date.now();
  const [fr, us] = await Promise.allSettled([collectFrenchPart(), collectUsPart()]);
  const report = (res) => res.status === 'fulfilled' ? { ok: true } : { ok: false, error: String(res.reason?.message || res.reason) };
  const data = {
    generated: new Date().toISOString(),
    tookMs: Date.now() - started,
    sources: { fr: report(fr), us: report(us) },
    fr: fr.status === 'fulfilled' ? fr.value : previous?.fr || null,
    us: us.status === 'fulfilled' ? us.value : previous?.us || null,
  };
  data.count = (data.fr ? 1 : 0) + (data.us ? 1 : 0);
  return data;
}
