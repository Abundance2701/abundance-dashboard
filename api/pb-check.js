/* GET /api/pb-check  → checks every client's profit-booking rule against the live market and, when a
   line of the rule is newly met, creates a Basecamp to-do for Haritha in "Profit booking clients" and
   emails service@abundanceindia.com. Called at 8:15 AM, 2:45/2:50 PM and 3:45/3:50 PM IST Mon–Fri by cron-job.org ("Abundance alerts", time zone Asia/Kolkata),
   with a twice-a-day backup run from .github/workflows/pb-check.yml. Problems are emailed (api/pb-check finish()).

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
     or Midcap 150 fall 2%  (or rise / new high …)                    backup index for the line above: whichever index meets it first
     remind 12/11/2026[, 26/02/2027 ...] [unless <words>]             a reminder; skipped if a line containing <words> already alerted
     … · ₹1,50,000 at the end of any line                            amount to move, shown in the alert title (not part of its memory key)
     deadline 15/01/2027                                              reminders 7 days before and on the day
   "close" = judged on the closing level only (3:45 PM run); "repeat" = may alert again (after a fresh move, at most once a day).
   TIMING (12/11/2026): every market trigger is judged near the close, not intraday: at the 2:45/2:50 PM runs the live
   level stands in for the close (alert in time to redeem before the 3 PM cut-off for today's NAV), and at the 3:45/3:50 PM
   runs the close itself catches what got there in the last minutes. The 8:15 AM run sends only dated reminders/deadlines.
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
const IDX = { 'nifty 50': ['NIFTY 50', '^NSEI'], 'nifty 500': ['NIFTY 500', '^CRSLDX'], 'midcap 150': ['NIFTY MIDCAP 150', 'NIFTYMIDCAP150.NS'], 'smallcap 250': ['NIFTY SMALLCAP 250', 'NIFTYSMLCAP250.NS'], 'multicap 50:25:25': ['NIFTY500 MULTICAP 50:25:25', null] };   /* Multicap: no Yahoo symbol, NSE only */
/* NSE's official MCP names: [live name, end-of-day history name] */
const NSEMCP = { 'nifty 50': ['NIFTY 50', 'Nifty 50'], 'nifty 500': ['NIFTY 500', 'Nifty 500'], 'midcap 150': ['NIFTY MIDCAP 150', 'Nifty Midcap 150'], 'smallcap 250': ['NIFTY SMLCAP 250', 'Nifty Smallcap 250'], 'multicap 50:25:25': ['NIFTY500 MULTICAP', 'Nifty500 Multicap 50:25:25'] };
const LABEL = { 'nifty 50': 'Nifty 50', 'nifty 500': 'Nifty 500', 'midcap 150': 'Midcap 150', 'smallcap 250': 'Smallcap 250', 'multicap 50:25:25': 'Multicap 50:25:25' };
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
const amtLabel = a => { const v = +String(a == null ? '' : a).replace(/[^\d.]/g, ''); return !v ? '' : v >= 1e7 ? ` (₹${(v / 1e7).toFixed(2)} Cr)` : v >= 1e5 ? ` (₹${(v / 1e5).toFixed(2)} L)` : ` (₹${fmt(v)})`; };
const hash = s => crypto.createHash('sha1').update(s.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);

/* ---------- reading a rule ---------- */
/* "Midcap", "nifty 500", "Multicap 50:25:25" … → the index key, or null */
const GOAL_IDX = ['nifty 50', 'midcap 150', 'smallcap 250'];
function normIdx(t) { const l = ' ' + String(t).toLowerCase().trim().replace(/\s+/g, ' ') + ' ';
  const n = l.replace(/\bnifty(?! ?50\b| ?500\b)/g, 'nifty 50').replace(/\bmidcap(?! 150)/g, 'midcap 150').replace(/\bsmallcap(?! 250)/g, 'smallcap 250').replace(/\b(?:nifty ?500 )?multicap(?: 50:25:25)?(?=\s)/g, 'multicap 50:25:25').trim();
  return Object.keys(LABEL).find(k => k === n) || null; }
const IDXRE = '(nifty 50|nifty 500|midcap 150|smallcap 250|multicap 50:25:25)';   /* Multicap 50:25:25 = Nifty500 Multicap 50:25:25 (50% large, 25% mid, 25% small) */
function parseRule(text) {
  const out = [], bad = [];
  let lastAt = null, G = null;   /* G = the goal block being read */
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim().replace(/\s+/g, ' '); if (!line) continue;
    /* optional amount at the end of a line: "… · ₹1,50,000" (shown in the alert title; not part of the alert's memory key) */
    /* one amount, or one per part for level lines: "… · ₹1,50,000 / ₹2,00,000"; a goal's Part line can end "· ₹5,57,000" */
    let lineAmt = null, lineAmts = null; const am = !/^goal alert:/i.test(line) && line.match(/\s*·\s*((?:(?:₹|rs\.?)\s*[\d,]+(?:\.\d+)?\s*\/?\s*)+)$/i);
    if (am) { lineAmts = [...am[1].matchAll(/(?:₹|rs\.?)\s*([\d,]+(?:\.\d+)?)/gi)].map(x => +x[1].replace(/,/g, '')); lineAmt = lineAmts.length === 1 ? lineAmts[0] : null; line = line.slice(0, am.index).trim(); }
    const n0 = out.length, la0 = lastAt;
    try {
    let gm;
    if ((gm = line.match(/^goal alert:\s*(.+)$/i))) { const [nm, ...rest] = gm[1].split('·').map(x => x.trim()); G = { type: 'gblock', name: nm || 'Goal', amt: rest.join(' · '), parts: [], by: null, trig: '52w', src: line }; out.push(G); lastAt = null; continue; }
    /* Part N of M: <from> [to <to>] [· levels Nifty 50 26358, Midcap 150 23650] [· ₹amount]   (no "to" = no end date) */
    if ((gm = line.match(/^part\s+(\d+)\s+of\s+(\d+)\s*:\s*(?:from\s+)?(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4}))?(?:\s*·\s*levels?\s+(.+))?$/i))) {
      const a = iso(gm[3]), b = gm[4] ? iso(gm[4]) : ''; let levels = null, okL = true;
      if (gm[5]) { levels = {}; gm[5].split(',').forEach(x => { const lm = x.trim().match(/^(.+?)\s+([\d,]+(?:\.\d+)?)$/), k = lm && normIdx(lm[1]); if (!k) okL = false; else levels[k] = +lm[2].replace(/,/g, ''); }); }
      if (!G || !a || (gm[4] && !b) || (b && b < a) || !okL) { bad.push(line); continue; }
      G.parts.push({ no: +gm[1], of: +gm[2], from: a, to: b, amt: lineAmt || null, levels }); G.src += '\n' + line; lineAmt = lineAmts = null; continue; }
    if ((gm = line.match(/^trigger\s*:\s*(.+)$/i))) {   /* what each part waits for */
      const t = gm[1].toLowerCase().trim(); let tr = null, pm;
      if (/^new high/.test(t)) tr = ['new']; else if (/^52/.test(t)) tr = ['52w']; else if (/^(all[- ]?time high|ath)\b/.test(t)) tr = ['ath']; else if (/^(index )?level/.test(t)) tr = ['level'];
      else if ((pm = t.match(/^(up|down|fall|rise)\s+([\d.]+)\s*%/))) tr = [pm[1], +pm[2]];
      if (!G || !tr || (tr[1] != null && !(tr[1] > 0))) { bad.push(line); continue; } G.trig = tr[0]; G.pct = tr[1] || null; G.src += '\n' + line; continue; }
    if ((gm = line.match(/^remind(?:ers?)?\s*:\s*(.+)$/i))) {   /* extra reminder dates for this alert */
      const ds = gm[1].split(',').map(x => iso(x.trim())); if (!G || !ds.length || ds.some(x => !x)) { bad.push(line); continue; } G.rem = ds; G.src += '\n' + line; continue; }
    if ((gm = line.match(/^(?:in debt by|done by|must be done by)\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})$/i))) { const d = iso(gm[1]); if (!G || !d) { bad.push(line); continue; } G.by = d; G.src += '\n' + line; continue; }
    if ((gm = line.match(/^watch for\s*:\s*(.+)$/i))) { if (!G) { bad.push(line); continue; } G.trig = /new high/i.test(gm[1]) && !/52/.test(gm[1]) ? 'new' : '52w'; G.src += '\n' + line; continue; }
    if ((gm = line.match(/^indices\s*:\s*(.+)$/i))) {   /* which indices a goal watches (any one); default Nifty 50, Midcap 150, Smallcap 250 */
      const ks = gm[1].split(/,|\bor\b|\//i).map(x => normIdx(x)).filter(Boolean);
      if (!G || !ks.length || ks.length !== gm[1].split(/,|\bor\b|\//i).filter(x => x.trim()).length) { bad.push(line); continue; } G.idxs = [...new Set(ks)]; G.src += '\n' + line; continue; }
    if (/^how\s*:/i.test(line)) { if (!G) bad.push(line); continue; }
    G = null;
    const tm = line.match(/^\[fp:?\s*([^\]]*)\]\s*/i), tag = tm ? (tm[1].trim() || 'Goal') : null;   // [FP …] = goal alert from the planning tool
    const l = line.slice(tm ? tm[0].length : 0).toLowerCase().replace(/\bnifty(?! ?50\b| ?500\b)/g, 'nifty 50').replace(/\b(up|down) by\b/g, '$1').replace(/\bmidcap(?! 150)/g, 'midcap 150').replace(/\bsmallcap(?! 250)/g, 'smallcap 250').replace(/\b(?:nifty ?500 )?multicap(?: 50:25:25)?\b/g, 'multicap 50:25:25');
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
    if ((m = l.match(new RegExp('^(or )?' + IDXRE + ' new high')))) {
      if (m[1]) { if (!lastAt || lastAt.type !== 'newHigh') { bad.push(line); continue; } lastAt.alts.push({ idx: m[2] }); lastAt.src += '\n' + line; continue; }
      if (!from) { bad.push(line); continue; }
      lastAt = { type: 'newHigh', idx: m[2], alts: [{ idx: m[2] }], from, until, src: line, tag }; out.push(lastAt); continue; }
    if ((m = l.match(new RegExp('^(or )?' + IDXRE + ' (fall|rise) ([\\d.]+) ?%( above high)?')))) {
      const type = m[3] === 'fall' ? 'fall' : m[5] ? 'aboveHigh' : 'rise';
      if (m[1]) { if (!lastAt || lastAt.type !== type) { bad.push(line); continue; } lastAt.alts.push({ idx: m[2], pct: +m[4] }); lastAt.src += '\n' + line; continue; }
      if (!from) { bad.push(line); continue; }
      lastAt = { type, idx: m[2], pct: +m[4], alts: [{ idx: m[2], pct: +m[4] }], from, until, close: /\bclose\b/.test(l), repeat: /\brepeat\b/.test(l), src: line, tag }; out.push(lastAt); continue;
    }
    if (/^or /.test(l) && lastAt) { bad.push(line); continue; }
    lastAt = null;
    if ((m = l.match(/^remind ([\d/,\s]+?)( unless (.+))?$/))) {
      const ds = m[1].split(',').map(x => iso(x.trim())); if (!ds.length || ds.some(x => !x)) { bad.push(line); continue; }
      out.push({ type: 'remind', dates: ds, unless: m[3] ? m[3].trim() : null, src: line, tag }); continue;
    }
    if ((m = l.match(/^move to debt from (\d{1,2}\/\d{1,2}\/\d{4}) by (\d{1,2}\/\d{1,2}\/\d{4})$/))) { const f = iso(m[1]), b = iso(m[2]); if (!f || !b) { bad.push(line); continue; } out.push({ type: 'goal', start: f, by: b, src: line, tag }); continue; }
    if ((m = l.match(/^deadline (\d{1,2}\/\d{1,2}\/\d{4})$/))) { const d = iso(m[1]); out.push({ type: 'remind', dates: [addDays(d, -7), d], deadline: d, src: line, tag }); continue; }
    bad.push(line);
    } finally { if (lineAmt || lineAmts) { const t = out.length > n0 ? out[out.length - 1] : la0; if (t && t.type !== 'gblock') { if (lineAmts && lineAmts.length > 1) { if (!t.amts) t.amts = lineAmts; } else if (t.amt == null) t.amt = lineAmt; } } }
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
async function mcpHistory(k, years = 2) {
  const name = NSEMCP[k][1], rows = [];
  let end = 'today';
  for (let i = 0; i < years; i++) {
    const j = await N.call('eod', 'get_index_history', { indexName: name, months: 12, endDate: end });
    (j.data || []).forEach(r => { if (r.date && isFinite(+r.close) && +r.close > 0) rows.push([r.date, +r.close]); });
    if (!j.next_end_date) break; end = j.next_end_date;
  }
  if (rows.length < 200) throw new Error('only ' + rows.length + ' days');
  const seen = {}; return rows.filter(r => !seen[r[0]] && (seen[r[0]] = 1)).sort((a, b) => a[0] < b[0] ? -1 : 1);
}
/* NSE closes first; Yahoo only fills days after NSE's latest file (NSE publishes after hours) or if NSE fails. */
async function closesFor(k, T, src, years = 2) {
  let nse = null, err = '';
  try { nse = await mcpHistory(k, years); } catch (e) { err = e.message; }
  const lastWeekday = (() => { const d = new Date(T + 'T00:00:00Z'); do d.setUTCDate(d.getUTCDate() - 1); while ([0, 6].includes(d.getUTCDay())); return d.toISOString().slice(0, 10); })();
  if (nse && nse[nse.length - 1][0] >= lastWeekday) { src[k] = 'NSE'; return nse; }
  let y = null; try { if (!IDX[k][1]) throw new Error('no Yahoo symbol'); y = await history(IDX[k][1]); } catch (e) { if (!nse) throw new Error('nse: ' + err + '; ' + e.message); }
  if (!nse) { src[k] = 'Yahoo (NSE failed: ' + err + ')'; return y; }
  const last = nse[nse.length - 1][0], add = [];
  let prev = nse[nse.length - 1][1];
  for (const r of (y || []).filter(r => r[0] > last && r[0] < T)) {        // Yahoo repeats the last close on NSE holidays: skip those rows
    if (Math.abs(r[1] / prev - 1) < 0.00005) continue;
    add.push(r); prev = r[1];
  }
  src[k] = add.length ? `NSE + Yahoo for ${add.length} day(s) after ${last}` : 'NSE';
  return nse.concat(add);
}

module.exports = async (req, res) => {
  const dry = !!(req.query && req.query.dry);
  const T = today(), ist = istNow(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes(), wd = ist.getUTCDay();
  const closedForDay = wd === 0 || wd === 6 || mins >= 15 * 60 + 31;
  const notes = [], problems = []; let fired = 0, sent = 0, badLines = 0;
  const marketHours = wd >= 1 && wd <= 5 && mins >= 9 * 60 + 20 && mins <= 15 * 60 + 30;
  let contacts, todos, memo = null;
  try { [contacts, todos] = await Promise.all([zohoContacts(), B.alertTodos()]); }
  catch (e) { problems.push({ type: 'read', text: 'Could not read the alert rules from Zoho CRM or the alert to-dos from Basecamp: ' + e.message + '. No alerts can be checked until this is fixed.' }); return finish(res, { dry, problems, notes, keys: {}, memo, T, mins }); }
  try { memo = await B.memoryDoc(); } catch (e) { notes.push('memory: ' + e.message); problems.push({ type: 'memory', text: 'Could not read the "Alert memory" document in Basecamp (Investments → Docs & Files): ' + e.message + '. Alerts still work from the to-do list, but a to-do that was moved or deleted could alert again.' }); }
  const keys = {};                                       // "<contact>/<line>" → [dates alerted]; from the alert to-dos AND the memory document
  const addKeys = txt => { for (const m of String(txt || '').matchAll(/pb-key:\s*([\w\-]+\/[\w\-]+)\/(\d{4}-\d{2}-\d{2})/g)) { const a = (keys[m[1]] = keys[m[1]] || []); if (!a.includes(m[2])) a.push(m[2]); } };
  todos.forEach(t => addKeys(t.description)); if (memo) addKeys(memo.content);
  const known = new Set(Object.entries(keys).flatMap(([k, ds]) => ds.map(d => k + '/' + d)));
  const last = k => (keys[k] || []).sort().slice(-1)[0] || null;

  let L = {}, liveSrc = 'NSE MCP';
  try { L = await mcpLive(); } catch (e) { notes.push('live nse-mcp: ' + e.message); liveSrc = 'NSE website'; try { L = await nse(); } catch (e2) { notes.push('live: ' + e2.message); liveSrc = 'none'; } }
  const H = {};
  const histSrc = {};
  const years = contacts.some(c => /all[- ]?time high|\bath\b/i.test(String(c[FIELD] || ''))) ? 5 : 2;   /* all-time high needs the long history */
  await Promise.all(Object.keys(IDX).map(async k => { try { H[k] = (await closesFor(k, T, histSrc, years)).filter(r => r[0] < T); } catch (e) { notes.push(k + ' history: ' + e.message); } }));
  const missLive = Object.keys(IDX).filter(k => !(L[k] > 0)), missHist = Object.keys(IDX).filter(k => !(H[k] && H[k].length > 150));
  if (missLive.length && marketHours) problems.push({ type: 'live', text: 'No live market level for ' + missLive.map(k => LABEL[k]).join(', ') + ' (' + notes.filter(n => /live/.test(n)).join('; ') + '). Alerts that depend on these indices are not being checked right now.' });
  if (missHist.length) problems.push({ type: 'history', text: 'No closing-price history for ' + missHist.map(k => LABEL[k]).join(', ') + ' (' + notes.filter(n => /history/.test(n)).join('; ') + '). Alerts that need past closes for these indices are not being checked right now.' });
  const closes = (idx, a, b) => (H[idx] || []).filter(r => r[0] >= a && (!b || r[0] <= b)).map(r => r[1]);
  const ok = v => v != null && isFinite(v) && v > 0;
  /* Market triggers are judged near the close, not intraday (MF NAVs use the closing value):
     2:40–3:00 PM IST on weekdays the live level stands in for the close, in time to redeem before the 3 PM cut-off;
     from 3:31 PM the live level IS the close. Other runs (8:15 AM) send only dated reminders and deadlines.
     ?market=1 or ?dry=market forces a market check (?dry=market = a dry run that also checks the market). */
  const weekday = wd >= 1 && wd <= 5, nearClose = weekday && mins >= 14 * 60 + 40 && mins <= 15 * 60, afterClose = weekday && mins >= 15 * 60 + 31;
  const marketNow = nearClose || afterClose || !!(req.query && (req.query.market || req.query.dry === 'market'));
  const hhmm = `${String(Math.floor(mins / 60) % 12 || 12)}:${String(mins % 60).padStart(2, '0')} ${mins >= 720 ? 'PM' : 'AM'}`;
  const AT = v => afterClose ? `closed at ${fmt(v)}` : `is at ${fmt(v)} at ${hhmm} IST, near the close`;
  const endedOn = d => (T > d || (T === d && afterClose)) && T <= addDays(d, 10);   // a period counts as over only after that day's close

  const due = [];
  for (const c of contacts) {
    const name = c.Full_Name || 'Client', { lines, bad } = parseRule(c[FIELD]);
    for (const b of bad) {
      const k = `${c.id}/bad-${hash(b)}`; if (last(k) === T) continue;
      badLines++; due.push({ c, k, title: `${name}: check this profit-booking rule line`, hit: `This line in Goal Alerts could not be read, so it is not being watched: "${b}". Fix it in Zoho CRM. Valid examples: "Nifty 50 at 26358, 27400" · "or Midcap 150 at 23650" · "Nifty 50 up 9% from 05/11/2026" · "Nifty 50 52w high from 05/11/2026 until 04/02/2027" · "move to debt from 05/11/2026 by 31/08/2027" · "Nifty 50 fall 2% from 13/11/2026 until 15/01/2027" · "Nifty 500 rise 10% repeat from 05/11/2026" · "remind 12/11/2026" · "deadline 15/01/2027". Dates as DD/MM/YYYY.` });
    }
    for (const R of lines) {
      const nm = (R.tag ? `${name} · ${R.tag}` : name) + (R.amt ? amtLabel(R.amt) : '');
      if (R.from && T < R.from) continue;
      if (R.until && T > R.until) continue;
      const base = `${c.id}/${R.id}`;
      if (R.type === 'at') {
        if (!marketNow) continue;
        const n = Math.max(...R.alts.map(a => a.levels.length));
        for (let i = 0; i < n; i++) {
          const k = `${base}-p${i + 1}`; if (last(k)) continue;
          const a = R.alts.find(a => a.levels[i] && ok(L[a.idx]) && L[a.idx] >= a.levels[i]);
          if (a) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${LABEL[a.idx]} at ${fmt(a.levels[i])}, book part ${i + 1} of ${n}${R.amts && R.amts[i] ? amtLabel(R.amts[i]) : ''}`, hit: `${LABEL[a.idx]} ${AT(L[a.idx])}, at or above the level of ${fmt(a.levels[i])}.` });
        }
        continue;
      }
      if (R.type === 'move') {                           // up/down X% from the close on the 'from' date; fires once, whichever index first
        if (!marketNow) continue;
        const k = `${base}-move`; if (last(k)) continue;
        for (const a of R.alts) {
          const b = (H[a.idx] || []).find(r => r[0] >= R.from), now = L[a.idx]; if (!b || !ok(now)) continue;
          const chg = (now / b[1] - 1) * 100, hitIt = a.dir === 'up' ? chg >= a.pct : chg <= -a.pct;
          if (hitIt) { due.push({ c, fp: !!R.tag, k, title: `${nm}: ${LABEL[a.idx]} ${a.dir} ${a.pct}% since ${dmy(b[0])}`, hit: `${LABEL[a.idx]} ${AT(now)}, ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(1)}% from its close of ${fmt(b[1])} on ${dmy(b[0])}.` }); break; }
        }
        continue;
      }
      if (R.type === 'gblock') {                         // goal block: per part a 52-week-high alert, else a reminder on its last day; then the deadline
        const GI = R.idxs || GOAL_IDX, win = d => T >= d && T <= addDays(d, 10);
        const amtS = amtLabel(R.amt);
        const who = `${name} · ${R.name}${amtS}`, gk = `${c.id}/g${hash(R.name)}`;
        R.parts.forEach((P, i) => {
          const pk = `${gk}-${hash(P.from + (P.to || '#' + P.no))}`, kw = `${pk}-w52`, ke = `${pk}-end`, of = `part ${P.no} of ${P.of}${P.amt ? amtLabel(P.amt) : ''}`, isLast = !!R.by && !!P.to && P.to >= addDays(R.by, -7); let hitNow = false;   /* a part ending in the last 7 days: the deadline alerts cover it */
          const kind = R.trig || '52w', pct = R.pct, WHAT = { new: `new high since ${dmy(P.from)}`, '52w': '52-week high', ath: 'all-time high', level: 'its level', up: `${pct}% rise`, down: `${pct}% fall`, fall: `${pct}% fall from its high`, rise: `${pct}% rise from its low` }[kind] || 'trigger';
          if (marketNow && !last(kw) && T >= P.from && (!P.to || T <= P.to)) for (const ix of GI) {
            const now = L[ix]; if (!ok(now)) continue; let hit = null;
            if (kind === 'new' || kind === '52w' || kind === 'ath') {
              const cs = kind === 'new' ? closes(ix, P.from) : kind === '52w' ? closes(ix, addDays(T, -364)) : closes(ix, '1900-01-01'); if (cs.length < (kind === 'new' ? 1 : 150)) continue; const hi = Math.max(...cs);
              if (now > hi) hit = [`at ${kind === 'new' ? 'a new high since ' + dmy(P.from) : kind === '52w' ? 'a 52-week high' : 'an all-time high'}`, `above its highest close ${kind === 'new' ? 'since ' + dmy(P.from) : kind === '52w' ? 'of the past 52 weeks' : 'ever (' + dmy((H[ix] || [])[0] ? H[ix][0][0] : P.from) + ' onwards)'} (${fmt(hi)})`];
            } else if (kind === 'level') {
              const lvl = P.levels && P.levels[ix]; if (!lvl) continue; if (now >= lvl) hit = [`at ${fmt(lvl)}`, `at or above the level of ${fmt(lvl)}`];
            } else if (kind === 'up' || kind === 'down') {
              const b = (H[ix] || []).find(r => r[0] >= P.from); if (!b) continue; const chg = (now / b[1] - 1) * 100;
              if (kind === 'up' ? chg >= pct - 1e-9 : chg <= -pct + 1e-9) hit = [`${kind} ${pct}% since ${dmy(b[0])}`, `${kind} ${Math.abs(chg).toFixed(1)}% from its close of ${fmt(b[1])} on ${dmy(b[0])}`];
            } else if (kind === 'fall') {
              const cs = closes(ix, P.from); cs.push(now); const hi = Math.max(...cs); if (now <= hi * (1 - pct / 100) * (1 + 1e-12)) hit = [`down ${pct}% from its high`, `${((1 - now / hi) * 100).toFixed(1)}% below its high of ${fmt(hi)} since ${dmy(P.from)}`];
            } else if (kind === 'rise') {
              const cs = closes(ix, P.from); if (!cs.length) continue; const lo = Math.min(...cs); if (now >= lo * (1 + pct / 100) * (1 - 1e-12)) hit = [`up ${pct}% from its low`, `up ${((now / lo - 1) * 100).toFixed(1)}% from its low of ${fmt(lo)} since ${dmy(P.from)}`];
            }
            if (hit) { hitNow = true; due.push({ c, fp: true, k: kw, title: `${who}: ${of}, ${LABEL[ix]} ${hit[0]}`, hit: `${LABEL[ix]} ${AT(now)}, ${hit[1]}. Review moving this part.` }); break; }
          }
          if (P.to && !hitNow && !isLast && !last(kw) && !last(ke) && endedOn(P.to)) due.push({ c, fp: true, k: ke, title: `${who}: ${of} ended with no ${WHAT}`, hit: `No ${WHAT} between ${dmy(P.from)} and ${dmy(P.to)}. Review moving this part.` });
        });
        if (R.by) [addDays(R.by, -7), R.by].forEach(d => { const k = `${gk}-by${hash(R.by)}-${d}`; if (!last(k) && win(d)) due.push({ c, fp: true, k, title: d === R.by ? `${who}: deadline today (${dmy(R.by)})` : `${who}: deadline in 7 days (${dmy(R.by)})`, hit: `This money must be fully moved by ${dmy(R.by)}.` }); });
        (R.rem || []).forEach(d => { const k = `${gk}-r${d}`; if (!last(k) && win(d)) due.push({ c, fp: true, k, title: `${who}: reminder for ${dmy(d)}`, hit: `Reminder for ${dmy(d)}.` }); });
        continue;
      }
      if (R.type === 'goal') {                           // goal money: quarterly 52-week-high alerts, quarter-end fallback, deadline
        const GI = ['nifty 50', 'midcap 150', 'smallcap 250'], win = d => T >= d && T <= addDays(d, 10);
        if (R.by <= R.start) { const k = `${base}-now`; if (!last(k) && win(R.start)) due.push({ c, fp: true, k, title: `${nm}: move to debt now`, hit: `The goal's deadline to be in debt (${dmy(R.by)}) has been reached.` }); continue; }
        const Q = quarters(R.start, R.by);
        Q.forEach(([qs, qe], i) => {
          const kw = `${base}-q${i + 1}-w52`, ke = `${base}-q${i + 1}-end`, of = `quarter ${i + 1} of ${Q.length}`; let hitNow = false;
          if (marketNow && !last(kw) && T >= qs && T <= qe) for (const ix of GI) {
            const now = L[ix], cs = closes(ix, addDays(T, -364)); if (!ok(now) || cs.length < 150) continue; const hi = Math.max(...cs);
            if (now > hi) { hitNow = true; due.push({ c, fp: true, k: kw, title: `${nm}: ${LABEL[ix]} at a 52-week high (${of})`, hit: `${LABEL[ix]} ${AT(now)}, above its highest close of the past 52 weeks (${fmt(hi)}). Good time to move this quarter's part to debt.` }); break; }
          }
          if (!hitNow && i < Q.length - 1 && !last(kw) && !last(ke) && endedOn(qe)) due.push({ c, fp: true, k: ke, title: `${nm}: ${of} ended, move a part to debt`, hit: `No 52-week high this quarter (${dmy(qs)} to ${dmy(qe)}). Review moving this quarter's part to debt. Must be fully in debt by ${dmy(R.by)}.` });
        });
        [addDays(R.by, -7), R.by].forEach(d => { const k = `${base}-${d}`; if (!last(k) && win(d)) due.push({ c, fp: true, k, title: `${nm}: ${d === R.by ? 'deadline today' : 'deadline in 7 days'} (${dmy(R.by)})`, hit: `This goal's money must be fully in debt by ${dmy(R.by)}.` }); });
        continue;
      }
      if (R.type === 'remind') {
        R.dates.forEach(d => {
          const k = `${base}-${d}`; if (last(k) || T < d || T > addDays(d, 10)) return;
          if (R.unless && T === d && !afterClose) return;   // "unless <market line>": wait for that day's close first
          const unlessIds = R.unless ? lines.filter(o => o !== R && o.src.toLowerCase().includes(R.unless.toLowerCase())).map(o => `${c.id}/${o.id}`) : [];
          if (unlessIds.some(id => Object.keys(keys).some(x => x.startsWith(id)))) return;
          const dl = R.deadline ? (d === R.deadline ? `Deadline today (${dmy(d)})` : `Deadline in 7 days (${dmy(R.deadline)})`) : `Reminder for ${dmy(d)}`;
          const qEnd = R.tag && R.unless && !R.deadline;   /* goal quarter-end line from the planning tool */
          due.push({ c, fp: !!R.tag, k, unlessIds, title: qEnd ? `${nm}: no 52-week high this quarter, move a part to debt` : `${nm}: ${dl.toLowerCase()}`, hit: qEnd ? `Quarter ended ${dmy(d)} without a 52-week high. Review moving this quarter's part to debt.` : `${dl}.` });
        });
        continue;
      }
      if (R.type === 'w52') {                            // above the highest close of the past 52 weeks; fires once, whichever index first
        if (!marketNow) continue;
        const k = `${base}-w52`; if (last(k)) continue;
        for (const a of R.alts) {
          const now = L[a.idx], cs = closes(a.idx, addDays(T, -364)); if (!ok(now) || cs.length < 150) continue;
          const hi = Math.max(...cs);
          if (now > hi) { due.push({ c, fp: !!R.tag, k, title: `${nm}: ${LABEL[a.idx]} at a 52-week high`, hit: `${LABEL[a.idx]} ${AT(now)}, above its highest close of the past 52 weeks (${fmt(hi)}).${R.tag ? " Good time to move this quarter's part to debt." : ''}` }); break; }
        }
        continue;
      }
      if (!marketNow) continue;                           // newHigh / fall / rise / aboveHigh
      const k = base, lf = last(k);
      if (lf && !R.repeat) continue;
      if (lf === T) continue;
      for (const A of (R.alts || [{ idx: R.idx, pct: R.pct }])) {           // first index (or backup) that meets it
        const now = L[A.idx]; if (!ok(now)) continue;
        const lab = LABEL[A.idx], pct = A.pct != null ? A.pct : R.pct, n0 = due.length;
        if (R.type === 'newHigh') {
          const cs = closes(A.idx, R.from); const hi = cs.length ? Math.max(...cs) : null;
          if (hi && now > hi) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} at a new high`, hit: `${lab} ${AT(now)}, above every close since ${dmy(R.from)} (best ${fmt(hi)}).` });
        } else if (R.type === 'fall') {
          if (R.close && !closedForDay) break;
          const since = (R.repeat && lf) || R.from, cs = closes(A.idx, since); cs.push(now);
          const hi = Math.max(...cs);
          if (now <= hi * (1 - pct / 100)) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} down ${pct}% from its high`, hit: `${lab} ${AT(now)}, ${((1 - now / hi) * 100).toFixed(1)}% below its high of ${fmt(hi)} since ${dmy(since)}.` });
        } else if (R.type === 'rise') {
          const since = lf || R.from, cs = closes(A.idx, since); if (!cs.length) continue;
          const lo = Math.min(...cs);
          if (now >= lo * (1 + pct / 100)) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} up ${pct}% from its low`, hit: `${lab} ${AT(now)}, up ${((now / lo - 1) * 100).toFixed(1)}% from its low of ${fmt(lo)} since ${dmy(since)}.` });
        } else if (R.type === 'aboveHigh') {
          const cs = closes(A.idx, addDays(R.from, -30), lf || addDays(R.from, -1)); if (!cs.length) continue;
          const hi = Math.max(...cs);
          if (now >= hi * (1 + pct / 100)) due.push({ c, fp: !!R.tag, k, title: `${nm}: ${lab} ${pct}% above its earlier high`, hit: `${lab} ${AT(now)}, ${((now / hi - 1) * 100).toFixed(1)}% above its earlier high of ${fmt(hi)}.` });
        }
        if (due.length > n0) break;
      }
    }
  }

  /* a "remind … unless <line>" reminder is dropped when that line alerts in this same run */
  for (let i = due.length - 1; i >= 0; i--) { const u = due[i].unlessIds; if (u && u.length && due.some(d => u.some(id => d.k.startsWith(id)))) due.splice(i, 1); }

  if (req.query && req.query.test) {                 // one clearly marked test alert, no memory key
    due.length = 0; due.push({ c: { id: 'test', PB_Plan: 'This is a test of the profit-booking alerts. Please mark this to-do complete.' }, k: 'test/test', title: 'TEST: profit-booking alert check', hit: 'Test only. Nothing to do.' });
  }
  const newKeys = [];
  for (const { c, k, title, hit, fp } of due) {
    fired++;
    if (dry) continue;
    const plan = c.PB_Plan ? esc(c.PB_Plan).replace(/\n/g, '<br>') : '';
    const body = `<div><strong>${fp ? 'Trigger reached, review moving this goal money to debt.' : 'Trigger reached, review for profit booking.'}</strong></div><div>${esc(hit)}</div>${plan ? `<div><br>Plan: ${plan}</div>` : ''}${fp ? '<div><br>Amount is from the plan date: check the current value, and include any SIP money built up for this goal.</div>' : ''}${navNote(hit) ? `<div><br>${navNote(hit)}</div>` : ''}<div><br>Check exit load and short-term tax on units held under a year before redeeming.</div>${k === 'test/test' ? '' : `<div><br>pb-key: ${k}/${T}</div>`}`;
    let todo;
    try { todo = await B.createTodo(title, body, T); } catch (e) { notes.push('basecamp: ' + e.message); problems.push({ type: 'basecamp', text: `Could not create the Basecamp to-do for an alert that is due ("${title}"): ${e.message}. It will be tried again on the next run.` }); continue; }   // no to-do → no email; tried again next run
    if (k !== 'test/test') newKeys.push(`${k}/${T}`);
    const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:15px;color:#39293E">
        <p style="font-size:17px;color:#005826"><b>${esc(title)}</b></p><p><b>${fp ? 'Trigger reached, review moving this goal money to debt.' : 'Trigger reached, review for profit booking.'}</b><br>${esc(hit)}</p>
        ${plan ? `<p>Plan: ${plan}</p>` : ''}${fp ? '<p>Amount is from the plan date: check the current value, and include any SIP money built up for this goal.</p>' : ''}${navNote(hit) ? `<p><b>${navNote(hit)}</b></p>` : ''}<p>Check exit load and short-term tax on units held under a year before redeeming.</p>
        <p><a href="${todo.app_url}">Open the Basecamp to-do</a> · <a href="https://abundance-dashboard-beta.vercel.app/Market_Pulse.html">Market Pulse</a></p>
        <p style="color:#6f6875;font-size:12px">Sent automatically by the Abundance dashboard from the Goal Alerts field in Zoho CRM. Internal reminder, not investment advice.</p></div>`;
    try { await mail((fp ? 'Goal alert · ' : 'Profit booking alert · ') + title, html); sent++; }
    catch (e) { notes.push('mail: ' + e.message); problems.push({ type: 'mail', text: `The alert "${title}" was added to Basecamp but the email could not be sent: ${e.message}.` }); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return finish(res, { dry, problems, notes, keys, memo, known, newKeys, T, mins, out: { clients: contacts.length, due: fired, unreadableLines: badLines, emailed: sent, live: L, sources: { live: liveSrc, history: histSrc } } });
};

const navNote = hit => /near the close/.test(hit) ? "Redeem before today's 3 PM cut-off to get today's NAV." : /closed at/.test(hit) ? "Today's 3 PM cut-off has passed: a redemption placed now gets the next working day's NAV." : '';

/* Send one email to the office inbox through Zoho Mail. Throws on failure. */
async function mail(subject, html) {
  const ACC = Z.env('ZOHO_MAIL_ACCOUNT_ID'), FROM = Z.env('FROM_ADDRESS'), tok = await Z.accessToken();
  const r = await fetch(`${Z.urls().mail}/api/accounts/${ACC}/messages`, { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromAddress: FROM, toAddress: TO, subject, content: html, mailFormat: 'html', askReceipt: 'no' }) });
  if (!r.ok) throw new Error('Zoho Mail ' + r.status);
}

/* End of a run: save the alert memory, email any problem once a day (every 2 hours if memory can't be read),
   and answer. The reply is HTTP 500 only when a problem could not be reported by email, so cron-job.org's
   own failure email is the last line of defence; a problem that WAS emailed answers 200 so cron-job.org
   doesn't switch the job off during a long outage. */
async function finish(res, { dry, problems, notes, keys, memo, known, newKeys = [], T, mins, out = {} }) {
  let unreported = 0;
  const sysKeys = [];
  if (problems.length && !dry) {
    const types = [...new Set(problems.map(p => p.type))];
    const todo = types.filter(t => !(keys[`sys/${t}`] || []).includes(T));
    const ok = memo ? todo.length > 0 : todo.length > 0 && mins % 120 < 15;   // no memory to note it in: at most every 2 hours
    if (ok) {
      const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:15px;color:#39293E"><p style="font-size:17px;color:#934E32"><b>The goal and profit-booking alert check ran into a problem</b></p>
        <ul>${problems.filter(p => todo.includes(p.type)).map(p => `<li>${esc(p.text)}</li>`).join('')}</ul>
        <p>Alerts that depend on this may be late or missed until it is fixed. Each problem is emailed at most once a day; the check keeps retrying every 15 minutes. Ask Claude to look into it.</p>
        <p style="color:#6f6875;font-size:12px">Sent automatically by the Abundance dashboard (api/pb-check).</p></div>`;
      try { await mail('Alert system problem · ' + todo.join(', '), html); todo.forEach(t => sysKeys.push(`sys/${t}/${T}`)); }
      catch (e) { unreported = todo.length; notes.push('problem mail: ' + e.message); }
    }
  }
  if (!dry && memo) {
    const add = [...newKeys, ...sysKeys];
    if (!memo.id || add.length) {                     // first run creates the document with everything known so far
      const all = [...new Set([...(known || []), ...add])].sort();
      try { await B.saveMemory(memo, all.map(k => 'pb-key: ' + k)); } catch (e) { notes.push('memory save: ' + e.message); }
    }
  }
  const code = unreported ? 500 : 200;
  return Z.reply(res, code, { ok: !problems.length, dry, ...out, problems: [...new Set(problems.map(p => p.type))], notes });
}

module.exports.config = { maxDuration: 60 };
module.exports.parseRule = parseRule;
module.exports.quarters = quarters;
/* used by api/alerts-edit.js (the Alert Editor) to show each alert's status with the same data and keys */
module.exports.hash = hash;
module.exports.data = { mcpLive, nse, closesFor, IDX, LABEL, today, addDays };
