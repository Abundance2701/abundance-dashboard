/* GET /api/pb-check  → checks every client's profit-booking rule against the live market and, when a
   line of the rule is newly met, creates a Basecamp to-do for Haritha in "Profit booking clients" and
   emails service@abundanceindia.com. Called every 15 minutes in market hours by .github/workflows/pb-check.yml.

   Rules live in Zoho CRM → Contacts, two fields: "Goal Alerts" (api Goal_Alerts, one trigger per line; replaced "PB Rule" on 06/11/2026) and "PB Plan" (note).
   Line formats (dates DD/MM/YYYY; index = Nifty 50 | Nifty 500 | Midcap 150 | Smallcap 250):
     Nifty 50 at 26358, 27400              one alert per level (part 1, part 2, ...)
     or Midcap 150 at 23650, 24600         backup for the line above: part N fires when ANY index reaches its Nth level
     Nifty 50 up 9% from 05/11/2026          up/down X% from that day's close; add 'or' lines for backups (fires once)
     Nifty 50 new high from 05/11/2026 until 25/11/2026
     Nifty 50 52w high from 05/11/2026 until 04/02/2027   above the highest close of the past 52 weeks (fires once);
     or Midcap 150 52w high                               add 'or' lines for backups (whichever index first)
     [FP Graduation · ₹8,00,000] move to debt from 05/11/2026 by 31/08/2027
                                  goal money (written by the Financial Planning Tool): the window is split into quarters;
                                  in each quarter one alert when Nifty 50 / Midcap 150 / Smallcap 250 makes a 52-week high,
                                  otherwise a reminder at quarter end; then the deadline 7 days before and on the 'by' date.
                                  If 'by' is on or before 'from', one "move to debt now" alert on the 'from' date.
     [FP …] in front of any line marks it as a goal alert; the tag is shown in the alert title.
     A goal block (what the Financial Planning Tool writes), one item per line:
       GOAL ALERT: Graduation - Kavya · ₹9,67,000
       Part 1 of 2: 06/11/2026 to 17/02/2027
       Part 2 of 2: 18/02/2027 to 31/05/2027
       In debt by: 01/06/2027
       Watch for: 52-week high                  (or: new high since the part's start; default 52-week high)
       How: …                                   (wording only, not read)
     Each part alerts once on a 52-week high (Nifty 50, else Midcap 150, else Smallcap 250); if none, a reminder on the
     part's last day (skipped when that day is within 7 days of In debt by, which has its own alerts); "In debt by" alerts 7 days before and on the day. Each part and the deadline
     remember their own alerts, so editing one date doesn't repeat the others.
     Nifty 50 fall 2% [close] [repeat] from <date> [until <date>]     fall from the highest close since <date>
     Nifty 500 rise 10% [repeat] from <date> [until <date>]           rise from the lowest close since <date>
     Nifty 50 rise 3% above high [repeat] from <date> [until <date>]  3% above the high of the month before <date>
     remind 12/11/2026[, 26/02/2027 ...] [unless <words>]             a reminder; skipped if a line containing <words> already alerted
     deadline 15/01/2027                                              reminders 7 days before and on the day
   "close" = judged on the closing level; "repeat" = may alert again (after a fresh move, at most once a day).
   Memory: each alert to-do carries a "pb-key" line, so nothing alerts twice. A line that can't be read
   creates one "check this rule" to-do a day. If live data is missing, no market alert is sent.
   The reply holds counts only, never client names. ?dry=1 shows what would fire without sending. */

const crypto = require('crypto');
const B = require('./_bc');
const Z = require('./_zoho');
const N = require('./_nsemcp');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TO = 'service@abundanceindia.com';
const FIELD = 'Goal_Alerts';   /* Contacts → "Goal Alerts" (large text, 32,000 characters): every alert rule, profit booking and goals */
const IDX = { 'nifty 50': ['NIFTY 50', '^NSEI'], 'nifty 500': ['NIFTY 500', '^CRSLDX'], 'midcap 150': ['NIFTY MIDCAP 150', 'NIFTYMIDCAP150.NS'], 'smallcap 250': ['NIFTY SMALLCAP 250', 'NIFTYSMLCAP250.NS'] };
/* NSE's official MCP names: [live name, end-of-day history name] */
const NSEMCP = { 'nifty 50': ['NIFTY 50', 'Nifty 50'], 'nifty 500': ['NIFTY 500', 'Nifty 500'], 'midcap 150': ['NIFTY MIDCAP 150', 'Nifty Midcap 150'], 'smallcap 250': ['NIFTY SMLCAP 250', 'Nifty Smallcap 250'] };
const LABEL = { 'nifty 50': 'Nifty 50', 'nifty 500': 'Nifty 500', 'midcap 150': 'Midcap 150', 'smallcap 250': 'Smallcap 250' };
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const today = () => istNow().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dmy = d => d.split('-').reverse().join('/');
const addMonths = (d, n) => { const [y, m, dd] = d.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(dd, last))).toISOString().slice(0, 10); };
const quarters = (from, by) => {   // the window split into equal parts of about 3 months (a 12-month window = 4 quarters)
  const days = Math.round((Date.parse(by) - Date.parse(from)) / 864e5); if (days <= 0) return [];
  const n = Math.max(1, Math.round(days / 91.3)), at = i => addDays(from, Math.round(days * i / n));
  return Array.from({ length: n }, (_, i) => [at(i), addDays(at(i + 1), -1)]); };
const iso = s => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const fmt = v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hash = s => crypto.createHash('sha1').update(s.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);

/* ---------- reading a rule ---------- */
const IDXRE = '(nifty 50|nifty 500|midcap 150|smallcap 250)';
function parseRule(text) {
  const out = [], bad = [];
  let lastAt = null, G = null;   /* G = the goal block being read */
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' '); if (!line) continue;
    let gm;
    if ((gm = line.match(/^goal alert:\s*(.+)$/i))) { const [nm, ...rest] = gm[1].split('·').map(x => x.trim()); G = { type: 'gblock', name: nm || 'Goal', amt: rest.join(' · '), parts: [], by: null, trig: '52w', src: line }; out.push(G); lastAt = null; continue; }
    if ((gm = line.match(/^part\s+(\d+)\s+of\s+(\d+)\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4})$/i))) {
      const a = iso(gm[3]), b = iso(gm[4]); if (!G || !a || !b || b < a) { bad.push(line); continue; } G.parts.push({ no: +gm[1], of: +gm[2], from: a, to: b }); G.src += '\n' + line; continue; }
    if ((gm = line.match(/^in debt by\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})$/i))) { const d = iso(gm[1]); if (!G || !d) { bad.push(line); continue; } G.by = d; G.src += '\n' + line; continue; }
    if ((gm = line.match(/^watch for\s*:\s*(.+)$/i))) { if (!G) { bad.push(line); continue; } G.trig = /new high/i.test(gm[1]) && !/52/.test(gm[1]) ? 'new' : '52w'; G.src += '\n' + line; continue; }
    if (/^how\s*:/i.test(line)) { if (!G) bad.push(line); continue; }
    G = null;
    const tm = line.match(/^\[fp:?\s*([^\]]*)\]\s*/i), tag = tm ? (tm[1].trim() || 'Goal') : null;   // [FP …] = goal alert from the planning tool
    const l = line.slice(tm ? tm[0].length : 0).toLowerCase().replace(/\bnifty(?! ?50\b| ?500\b)/g, 'nifty 50').replace(/\b(up|down) by\b/g, '$1').replace(/\bmidcap(?! 150)/g, 'midcap 150').replace(/\bsmallcap(?! 250)/g, 'smallcap 250');
    const dates = k => { const m = l.match(new RegExp(k + ' (\\d{1,2}/\\d{1,2}/\\d{4})')); return m ? iso(m[1]) : null; };
    const from = dates('from'), until = dates('until');
    let m;
    if ((m = l.match(new RegExp('^(or )?' + IDXRE + ' at ([\\d,\\s.]+)$')))) {
      const levels = m[3].split(',').map(x => +x.trim()).filter(x => x > 0);
      if (!levels.length) { bad.push(line); continue; }
      if (m[1]) { if (!lastAt) { bad.push(line); continue; } lastAt.alts.push({ idx: m[2], levels }); lastAt.src += '\n' + line; continue; }
      lastAt = { type: 'at', alts: [{ idx: m[2], levels }], src: line, tag }; out.push(lastAt); continue;
    }
    if ((m = l.match(new RegExp('^(or )?' + IDXRE + ' (up|down) ([\\d.]+) ?%')))) {
      if (!from) { bad.push(line); continue; }
      const alt = { idx: m[2], pct: +m[4], dir: m[3] };
      if (m[1]) { if (!lastAt || lastAt.type !== 'move') { bad.push(line); continue; } lastAt.alts.push(alt); lastAt.src += '\n' + line; continue; }
      lastAt = { type: 'move', alts: [alt], from, until, src: line, tag }; out.push(lastAt); continue;
    }
    if ((m = l.match(new RegExp('^(or )?' + IDXRE + ' 52 ?-?w(?:ee)?k? high')))) {
      if (m[1]) { if (!lastAt || lastAt.type !== 'w52') { bad.push(line); continue; } lastAt.alts.push({ idx: m[2] }); lastAt.src += '\n' + line; continue; }
      lastAt = { type: 'w52', alts: [{ idx: m[2] }], from, until, tag, src: line }; out.push(lastAt); continue;
    }
    if (m === null && /^or /.test(l) && lastAt && (lastAt.type === 'move' || lastAt.type === 'w52')) { bad.push(line); continue; }
    lastAt = null;
    if ((m = l.match(new RegExp('^' + IDXRE + ' new high')))) { if (!from) { bad.push(line); continue; } out.push({ type: 'newHigh', idx: m[1], from, until, src: line, tag }); continue; }
    if ((m = l.match(new RegExp('^' + IDXRE + ' (fall|rise) ([\\d.]+) ?%( above high)?')))) {
      if (!from) { bad.push(line); continue; }
      out.push({ type: m[2] === 'fall' ? 'fall' : m[4] ? 'aboveHigh' : 'rise', idx: m[1], pct: +m[3], from, until, close: /\bclose\b/.test(l), repeat: /\brepeat\b/.test(l), src: line, tag }); continue;
    }
    if ((m = l.match(/^remind ([\d/,\s]+?)( unless (.+))?$/))) {
      const ds = m[1].split(',').map(x => iso(x.trim())); if (!ds.length || ds.some(x => !x)) { bad.push(line); continue; }
      out.push({ type: 'remind', dates: ds, unless: m[3] ? m[3].trim() : null, src: line, tag }); continue;
    }
    if ((m = l.match(/^move to debt from (\d{1,2}\/\d{1,2}\/\d{4}) by (\d{1,2}\/\d{1,2}\/\d{4})$/))) { const f = iso(m[1]), b = iso(m[2]); if (!f || !b) { bad.push(line); continue; } out.push({ type: 'goal', start: f, by: b, src: line, tag }); continue; }
    if ((m = l.match(/^deadline (\d{1,2}\/\d{1,2}\/\d{4})$/))) { const d = iso(m[1]); out.push({ type: 'remind', dates: [addDays(d, -7), d], deadline: d, src: line, tag }); continue; }
    bad.push(line);
  }
  out.forEach(x => { x.id = hash(x.src); });
  return { lines: out, bad };
}

/* ---------- data ---------- */
async function zohoContacts() {
  const tok = await Z.accessToken(), H = { Authorization: `Zoho-oauthtoken ${tok}` };
  const has = c => c[FIELD] && String(c[FIELD]).trim();
  // COQL: Zoho can't filter on a large text field, so read every contact's rules (2,000 a call) and keep the filled ones
  try {
    const out = [];
    for (let off = 0; off < 20000; off += 2000) {
      const r = await fetch(`${Z.urls().crm}/crm/v8/coql`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ select_query: `select Full_Name, ${FIELD}, PB_Plan from Contacts where id is not null limit 2000 offset ${off}` }) });
      if (r.status === 204) break;
      if (!r.ok) throw new Error('coql ' + r.status);
      const j = await r.json(); (j.data || []).forEach(c => has(c) && out.push(c));
      if (!(j.info && j.info.more_records)) break;
    }
    return out;
  } catch (e) {}
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`${Z.urls().crm}/crm/v8/Contacts?fields=Full_Name,${FIELD},PB_Plan&per_page=200&page=${page}`, { headers: H });
    if (r.status === 204) break;
    if (!r.ok) throw new Error('Zoho CRM ' + r.status);
    const j = await r.json(); (j.data || []).forEach(c => has(c) && out.push(c));
    if (!(j.info && j.info.more_records)) break;
  }
  return out;
}
async function nse() {
  const h = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(6000) });
  const ck = (h.headers.getSetCookie ? h.headers.getSetCookie() : [h.headers.get('set-cookie') || '']).map(c => c.split(';')[0]).join('; ');
  const r = await fetch('https://www.nseindia.com/api/allIndices', { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/', Cookie: ck }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('nse ' + r.status);
  const j = await r.json(), map = {};
  (j.data || []).forEach(x => { map[String(x.index).toUpperCase()] = +x.last; });
  const out = {}; Object.entries(IDX).forEach(([k, [n]]) => { if (isFinite(map[n]) && map[n] > 0) out[k] = map[n]; });
  return out;
}
async function history(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const x = (await r.json()).chart.result[0], off = (x.meta.gmtoffset || 19800) * 1000;
  return x.timestamp.map((t, i) => [new Date(t * 1000 + off).toISOString().slice(0, 10), x.indicators.quote[0].close[i]]).filter(r => r[1] != null);
}
/* Live levels from NSE's official MCP (1-3 min delay). Falls back to nse() (NSE website) if it fails. */
async function mcpLive() {
  const j = await N.call('live', 'cm_get_live_indices', { group: '', nameFilter: '' });
  const map = {};
  Object.values(j.indices || {}).forEach(g => (g || []).forEach(x => { map[String(x.indexName).toUpperCase()] = +x.last; }));
  const out = {}; Object.entries(NSEMCP).forEach(([k, [n]]) => { if (isFinite(map[n]) && map[n] > 0) out[k] = map[n]; });
  if (!Object.keys(out).length) throw new Error('no index values');
  return out;
}
/* Daily closes, oldest first, from NSE's official end-of-day data: 2 years in two 12-month calls. */
async function mcpHistory(k) {
  const name = NSEMCP[k][1], rows = [];
  let end = 'today';
  for (let i = 0; i < 2; i++) {
    const j = await N.call('eod', 'get_index_history', { indexName: name, months: 12, endDate: end });
    (j.data || []).forEach(r => { if (r.date && isFinite(+r.close) && +r.close > 0) rows.push([r.date, +r.close]); });
    if (!j.next_end_date) break; end = j.next_end_date;
  }
  if (rows.length < 200) throw new Error('only ' + rows.length + ' days');
  const seen = {}; return rows.filter(r => !seen[r[0]] && (seen[r[0]] = 1)).sort((a, b) => a[0] < b[0] ? -1 : 1);
}
/* NSE closes first; Yahoo only fills days after NSE's latest file (NSE publishes after hours) or if NSE fails. */
async function closesFor(k, T, src) {
  let nse = null, err = '';
  try { nse = await mcpHistory(k); } catch (e) { err = e.message; }
  const lastWeekday = (() => { const d = new Date(T + 'T00:00:00Z'); do d.setUTCDate(d.getUTCDate() - 1); while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); })();
  if (nse && nse[nse.length - 1][0] >= lastWeekday) { src[k] = 'NSE'; return nse; }
  let y = null; try { y = await history(IDX[k][1]); } catch (e) { if (!nse) throw new Error('nse: ' + err + '; ' + e.message); }
  if (!nse) { src[k] = 'Yahoo (NSE failed: ' + err + ')'; return y; }
  const last = nse[nse.length - 1][0], add = (y || []).filter(r => r[0] > last);
  src[k] = add.length ? `NSE + Yahoo for ${add.length} day(s) after ${last}` : 'NSE';
  return nse.concat(add);
}

module.exports = async (req, res) => {
  const dry = !!(req.query && req.query.dry);
  const T = today(), ist = istNow(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes(), wd = ist.getUTCDay();
  const closedForDay = wd === 0 || wd === 6 || mins >= 15 * 60 + 31;
  const notes = []; let fired = 0, sent = 0, badLines = 0;
  let contacts, todos;
  try { [contacts, todos] = await Promise.all([zohoContacts(), B.alertTodos()]); }
  catch (e) { return Z.reply(res, 200, { ok: false, error: e.message }); }
  const keys = {};                                       // "<contact>/<line>" → [dates alerted]
  todos.forEach(t => { for (const m of String(t.description || '').matchAll(/pb-key:\s*([\w\-]+\/[\w\-]+)\/(\d{4}-\d{2}-\d{2})/g)) (keys[m[1]] = keys[m[1]] || []).push(m[2]); });
  const last = k => (keys[k] || []).sort().slice(-1)[0] || null;

  let L = {}, liveSrc = 'NSE MCP';
  try { L = await mcpLive(); } catch (e) { notes.push('live nse-mcp: ' + e.message); liveSrc = 'NSE website'; try { L = await nse(); } catch (e2) { notes.push('live: ' + e2.message); liveSrc = 'none'; } }
  const H = {};
  const histSrc = {};
  await Promise.all(Object.keys(IDX).map(async k => { try { H[k] = (await closesFor(k, T, histSrc)).filter(r => r[0] < T); } catch (e) { notes.push(k + ' history: ' + e.message); } }));
  const closes = (idx, a, b) => (H[idx] || []).filter(r => r[0] >= a && (!b || r[0] <= b)).map(r => r[1]);
  const ok = v => v != null && isFinite(v) && v > 0;

  const due = [];
  for (const c of contacts) {
    const name = c.Full_Name || 'Client', { lines, bad } = parseRule(c[FIELD]);
    for (const b of bad) {
      const k = `${c.id}/bad-${hash(b)}`; if (last(k) === T) continue;
      badLines++; due.push({ c, k, title: `${name}: check this profit-booking rule line`, hit: `This line in Goal Alerts could not be read, so it is not being watched: "${b}". Fix it in Zoho CRM. Valid examples: "Nifty 50 at 26358, 27400" · "or Midcap 150 at 23650" · "Nifty 50 up 9% from 05/11/2026" · "Nifty 50 52w high from 05/11/2026 until 04/02/2027" · "move to debt from 05/11/2026 by 31/08/2027" · "Nifty 50 fall 2% from 13/11/2026 until 15/01/2027" · "Nifty 500 rise 10% repeat from 05/11/2026" · "remind 12/11/2026" · "deadline 15/01/2027". Dates as DD/MM/YYYY.` });
    }
    for (const R of lines) {
      const nm = R.tag ? `${name} · ${R.tag}` : name;
      if (R.from && T < R.from) continue;
      if (R.until && T > R.until) continue;
      const base = `${c.id}/${R.id}`;
      if (R.type === 'at') {
        const n = Math.max(...R.alts.map(a => a.levels.length));
        for (let i = 0; i < n; i++) {
          const k = `${base}-p${i + 1}`; if (last(k)) continue;
          const a = R.alts.find(a => a.levels[i] && ok(L[a.idx]) && L[a.idx] >= a.levels[i]);
          if (a) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${LABEL[a.idx]} at ${fmt(a.levels[i])}, book part ${i + 1} of ${n}`, hit: `${LABEL[a.idx]} is at ${fmt(L[a.idx])}, at or above the level of ${fmt(a.levels[i])}.` });
        }
        continue;
      }
      if (R.type === 'move') {                           // up/down X% from the close on the 'from' date; fires once, whichever index first
        const k = `${base}-move`; if (last(k)) continue;
        for (const a of R.alts) {
          const b = (H[a.idx] || []).find(r => r[0] >= R.from), now = L[a.idx]; if (!b || !ok(now)) continue;
          const chg = (now / b[1] - 1) * 100, hitIt = a.dir === 'up' ? chg >= a.pct : chg <= -a.pct;
          if (hitIt) { due.push({ c, fp: !!R.tag, k, title: `${nm}: ${LABEL[a.idx]} ${a.dir} ${a.pct}% since ${dmy(b[0])}`, hit: `${LABEL[a.idx]} is at ${fmt(now)}, ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(1)}% from its close of ${fmt(b[1])} on ${dmy(b[0])}.` }); break; }
        }
        continue;
      }
      if (R.type === 'gblock') {                         // goal block: per part a 52-week-high alert, else a reminder on its last day; then the deadline
        const GI = ['nifty 50', 'midcap 150', 'smallcap 250'], win = d => T >= d && T <= addDays(d, 5);
        const amtS = (() => { const v = +String(R.amt).replace(/[^\d.]/g, ''); return !v ? '' : v >= 1e7 ? ` (₹${(v / 1e7).toFixed(2)} Cr)` : v >= 1e5 ? ` (₹${(v / 1e5).toFixed(2)} L)` : ` (₹${fmt(v)})`; })();
        const who = `${name} · ${R.name}${amtS}`, gk = `${c.id}/g${hash(R.name)}`;
        R.parts.forEach((P, i) => {
          const pk = `${gk}-${hash(P.from + P.to)}`, kw = `${pk}-w52`, ke = `${pk}-end`, of = `part ${P.no} of ${P.of}`, isLast = !!R.by && P.to >= addDays(R.by, -7); let hitNow = false;   /* a part ending in the last 7 days: the In debt by alerts cover it */
          const nh = R.trig === 'new', what = nh ? `new high since ${dmy(P.from)}` : '52-week high';
          if (!last(kw) && T >= P.from && T <= P.to) for (const ix of GI) {
            const now = L[ix], cs = nh ? closes(ix, P.from) : closes(ix, addDays(T, -364)); if (!ok(now) || cs.length < (nh ? 1 : 150)) continue; const hi = Math.max(...cs);
            if (now > hi) { hitNow = true; due.push({ c, fp: true, k: kw, title: `${who}: ${of}, ${LABEL[ix]} at a ${what}`, hit: `${LABEL[ix]} is at ${fmt(now)}, above its highest close ${nh ? 'since ' + dmy(P.from) : 'of the past 52 weeks'} (${fmt(hi)}). Review moving this part to debt.` }); break; }
          }
          if (!hitNow && !isLast && !last(kw) && !last(ke) && win(P.to)) due.push({ c, fp: true, k: ke, title: `${who}: ${of} ended with no ${nh ? 'new high' : '52-week high'}`, hit: `No ${what} between ${dmy(P.from)} and ${dmy(P.to)}. Review moving this part to debt.` });
        });
        if (R.by) [addDays(R.by, -7), R.by].forEach(d => { const k = `${gk}-by${hash(R.by)}-${d}`; if (!last(k) && win(d)) due.push({ c, fp: true, k, title: d === R.by ? `${who}: must be fully in debt today (${dmy(R.by)})` : `${who}: must be fully in debt by ${dmy(R.by)} (7 days left)`, hit: `This goal's money must be fully in debt by ${dmy(R.by)}.` }); });
        continue;
      }
      if (R.type === 'goal') {                           // goal money: quarterly 52-week-high alerts, quarter-end fallback, deadline
        const GI = ['nifty 50', 'midcap 150', 'smallcap 250'], win = d => T >= d && T <= addDays(d, 5);
        if (R.by <= R.start) { const k = `${base}-now`; if (!last(k) && win(R.start)) due.push({ c, fp: true, k, title: `${nm}: move to debt now`, hit: `The goal's deadline to be in debt (${dmy(R.by)}) has been reached.` }); continue; }
        const Q = quarters(R.start, R.by);
        Q.forEach(([qs, qe], i) => {
          const kw = `${base}-q${i + 1}-w52`, ke = `${base}-q${i + 1}-end`, of = `quarter ${i + 1} of ${Q.length}`; let hitNow = false;
          if (!last(kw) && T >= qs && T <= qe) for (const ix of GI) {
            const now = L[ix], cs = closes(ix, addDays(T, -364)); if (!ok(now) || cs.length < 150) continue; const hi = Math.max(...cs);
            if (now > hi) { hitNow = true; due.push({ c, fp: true, k: kw, title: `${nm}: ${LABEL[ix]} at a 52-week high (${of})`, hit: `${LABEL[ix]} is at ${fmt(now)}, above its highest close of the past 52 weeks (${fmt(hi)}). Good time to move this quarter's part to debt.` }); break; }
          }
          if (!hitNow && i < Q.length - 1 && !last(kw) && !last(ke) && win(qe)) due.push({ c, fp: true, k: ke, title: `${nm}: ${of} ended, move a part to debt`, hit: `No 52-week high this quarter (${dmy(qs)} to ${dmy(qe)}). Review moving this quarter's part to debt. Must be fully in debt by ${dmy(R.by)}.` });
        });
        [addDays(R.by, -7), R.by].forEach(d => { const k = `${base}-${d}`; if (!last(k) && win(d)) due.push({ c, fp: true, k, title: `${nm}: ${d === R.by ? 'deadline today' : 'deadline in 7 days'} (${dmy(R.by)})`, hit: `This goal's money must be fully in debt by ${dmy(R.by)}.` }); });
        continue;
      }
      if (R.type === 'remind') {
        R.dates.forEach(d => {
          const k = `${base}-${d}`; if (last(k) || T < d || T > addDays(d, 5)) return;
          if (R.unless) { const fired = lines.some(o => o !== R && o.src.toLowerCase().includes(R.unless.toLowerCase()) && Object.keys(keys).some(x => x.startsWith(`${c.id}/${o.id}`))); if (fired) return; }
          const dl = R.deadline ? (d === R.deadline ? `Deadline today (${dmy(d)})` : `Deadline in 7 days (${dmy(R.deadline)})`) : `Reminder for ${dmy(d)}`;
          const qEnd = R.tag && R.unless && !R.deadline;   /* goal quarter-end line from the planning tool */
          due.push({ c, fp: !!R.tag, k, title: qEnd ? `${nm}: no 52-week high this quarter, move a part to debt` : `${nm}: ${dl.toLowerCase()}`, hit: qEnd ? `Quarter ended ${dmy(d)} without a 52-week high. Review moving this quarter's part to debt.` : `${dl}.` });
        });
        continue;
      }
      if (R.type === 'w52') {                            // above the highest close of the past 52 weeks; fires once, whichever index first
        const k = `${base}-w52`; if (last(k)) continue;
        for (const a of R.alts) {
          const now = L[a.idx], cs = closes(a.idx, addDays(T, -364)); if (!ok(now) || cs.length < 150) continue;
          const hi = Math.max(...cs);
          if (now > hi) { due.push({ c, fp: !!R.tag, k, title: `${nm}: ${LABEL[a.idx]} at a 52-week high`, hit: `${LABEL[a.idx]} is at ${fmt(now)}, above its highest close of the past 52 weeks (${fmt(hi)}).${R.tag ? " Good time to move this quarter's part to debt." : ''}` }); break; }
        }
        continue;
      }
      const k = base, lf = last(k);
      if (lf && !R.repeat) continue;
      if (lf === T) continue;
      const now = L[R.idx]; if (!ok(now)) continue;
      const lab = LABEL[R.idx];
      if (R.type === 'newHigh') {
        const cs = closes(R.idx, R.from); const hi = cs.length ? Math.max(...cs) : null;
        if (hi && now > hi) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} at a new high`, hit: `${lab} is at ${fmt(now)}, above every close since ${dmy(R.from)} (best ${fmt(hi)}).` });
      } else if (R.type === 'fall') {
        if (R.close && !closedForDay) continue;
        const since = (R.repeat && lf) || R.from, cs = closes(R.idx, since); cs.push(now);
        const hi = Math.max(...cs);
        if (now <= hi * (1 - R.pct / 100)) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} down ${R.pct}% from its high`, hit: `${lab} ${R.close ? 'closed' : 'is'} at ${fmt(now)}, ${((1 - now / hi) * 100).toFixed(1)}% below its high of ${fmt(hi)} since ${dmy(since)}.` });
      } else if (R.type === 'rise') {
        const since = lf || R.from, cs = closes(R.idx, since); if (!cs.length) continue;
        const lo = Math.min(...cs);
        if (now >= lo * (1 + R.pct / 100)) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} up ${R.pct}% from its low`, hit: `${lab} is at ${fmt(now)}, up ${((now / lo - 1) * 100).toFixed(1)}% from its low of ${fmt(lo)} since ${dmy(since)}.` });
      } else if (R.type === 'aboveHigh') {
        const cs = closes(R.idx, addDays(R.from, -30), lf || addDays(R.from, -1)); if (!cs.length) continue;
        const hi = Math.max(...cs);
        if (now >= hi * (1 + R.pct / 100)) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} ${R.pct}% above its earlier high`, hit: `${lab} is at ${fmt(now)}, ${((now / hi - 1) * 100).toFixed(1)}% above its earlier high of ${fmt(hi)}.` });
      }
    }
  }

  if (req.query && req.query.test) {                 // one clearly marked test alert, no memory key
    due.length = 0; due.push({ c: { id: 'test', PB_Plan: 'This is a test of the profit-booking alerts. Please mark this to-do complete.' }, k: 'test/test', title: 'TEST: profit-booking alert check', hit: 'Test only. Nothing to do.' });
  }
  for (const { c, k, title, hit, fp } of due) {
    fired++;
    if (dry) continue;
    const plan = c.PB_Plan ? esc(c.PB_Plan).replace(/\n/g, '<br>') : '';
    const body = `<div><strong>${fp ? 'Trigger reached, review moving this goal money to debt.' : 'Trigger reached, review for profit booking.'}</strong></div><div>${esc(hit)}</div>${plan ? `<div><br>Plan: ${plan}</div>` : ''}${fp ? '<div><br>Amount is from the plan date: check the current value, and include any SIP money built up for this goal.</div>' : ''}<div><br>Check exit load and short-term tax on units held under a year before redeeming.</div>${k === 'test/test' ? '' : `<div><br>pb-key: ${k}/${T}</div>`}`;
    let todo;
    try { todo = await B.createTodo(title, body, T); } catch (e) { notes.push('basecamp: ' + e.message); continue; }   // no to-do → no email, so the memory stays consistent
    try {
      const ACC = Z.env('ZOHO_MAIL_ACCOUNT_ID'), FROM = Z.env('FROM_ADDRESS'), tok = await Z.accessToken();
      const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:15px;color:#39293E">
        <p style="font-size:17px;color:#005826"><b>${esc(title)}</b></p><p><b>${fp ? 'Trigger reached, review moving this goal money to debt.' : 'Trigger reached, review for profit booking.'}</b><br>${esc(hit)}</p>
        ${plan ? `<p>Plan: ${plan}</p>` : ''}${fp ? '<p>Amount is from the plan date: check the current value, and include any SIP money built up for this goal.</p>' : ''}<p>Check exit load and short-term tax on units held under a year before redeeming.</p>
        <p><a href="${todo.app_url}">Open the Basecamp to-do</a> · <a href="https://abundance-dashboard-beta.vercel.app/Market_Pulse.html">Market Pulse</a></p>
        <p style="color:#6f6875;font-size:12px">Sent automatically by the Abundance dashboard from the Goal Alerts field in Zoho CRM. Internal reminder, not investment advice.</p></div>`;
      const r = await fetch(`${Z.urls().mail}/api/accounts/${ACC}/messages`, { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAddress: FROM, toAddress: TO, subject: (fp ? 'Goal alert · ' : 'Profit booking alert · ') + title, content: html, mailFormat: 'html', askReceipt: 'no' }) });
      if (r.ok) sent++; else notes.push('mail ' + r.status);
    } catch (e) { notes.push('mail: ' + e.message); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return Z.reply(res, 200, { ok: true, dry, clients: contacts.length, due: fired, unreadableLines: badLines, emailed: sent, live: L, sources: { live: liveSrc, history: histSrc }, notes });
};

module.exports.parseRule = parseRule;
module.exports.quarters = quarters;
