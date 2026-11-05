/* GET /api/pb-check  → checks every client's profit-booking rule against the live market and, when a
   line of the rule is newly met, creates a Basecamp to-do for Haritha in "Profit booking clients" and
   emails service@abundanceindia.com. Called every 15 minutes in market hours by .github/workflows/pb-check.yml.

   Rules live in Zoho CRM → Contacts, two fields: "PB Rule" (one trigger per line) and "PB Plan" (note).
   Line formats (dates DD/MM/YYYY; index = Nifty 50 | Nifty 500 | Midcap 150 | Smallcap 250):
     Nifty 50 at 26358, 27400              one alert per level (part 1, part 2, ...)
     or Midcap 150 at 23650, 24600         backup for the line above: part N fires when ANY index reaches its Nth level
     Nifty 50 new high from 05/11/2026 until 25/11/2026
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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TO = 'service@abundanceindia.com';
const IDX = { 'nifty 50': ['NIFTY 50', '^NSEI'], 'nifty 500': ['NIFTY 500', '^CRSLDX'], 'midcap 150': ['NIFTY MIDCAP 150', 'NIFTYMIDCAP150.NS'], 'smallcap 250': ['NIFTY SMALLCAP 250', 'NIFTYSMLCAP250.NS'] };
const LABEL = { 'nifty 50': 'Nifty 50', 'nifty 500': 'Nifty 500', 'midcap 150': 'Midcap 150', 'smallcap 250': 'Smallcap 250' };
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const today = () => istNow().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dmy = d => d.split('-').reverse().join('/');
const iso = s => { const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const fmt = v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hash = s => crypto.createHash('sha1').update(s.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);

/* ---------- reading a rule ---------- */
const IDXRE = '(nifty 50|nifty 500|midcap 150|smallcap 250)';
function parseRule(text) {
  const out = [], bad = [];
  let lastAt = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' '); if (!line) continue;
    const l = line.toLowerCase();
    const dates = k => { const m = l.match(new RegExp(k + ' (\\d{1,2}/\\d{1,2}/\\d{4})')); return m ? iso(m[1]) : null; };
    const from = dates('from'), until = dates('until');
    let m;
    if ((m = l.match(new RegExp('^(or )?' + IDXRE + ' at ([\\d,\\s.]+)$')))) {
      const levels = m[3].split(',').map(x => +x.trim()).filter(x => x > 0);
      if (!levels.length) { bad.push(line); continue; }
      if (m[1]) { if (!lastAt) { bad.push(line); continue; } lastAt.alts.push({ idx: m[2], levels }); lastAt.src += '\n' + line; continue; }
      lastAt = { type: 'at', alts: [{ idx: m[2], levels }], src: line }; out.push(lastAt); continue;
    }
    lastAt = null;
    if ((m = l.match(new RegExp('^' + IDXRE + ' new high')))) { if (!from) { bad.push(line); continue; } out.push({ type: 'newHigh', idx: m[1], from, until, src: line }); continue; }
    if ((m = l.match(new RegExp('^' + IDXRE + ' (fall|rise) ([\\d.]+) ?%( above high)?')))) {
      if (!from) { bad.push(line); continue; }
      out.push({ type: m[2] === 'fall' ? 'fall' : m[4] ? 'aboveHigh' : 'rise', idx: m[1], pct: +m[3], from, until, close: /\bclose\b/.test(l), repeat: /\brepeat\b/.test(l), src: line }); continue;
    }
    if ((m = l.match(/^remind ([\d/,\s]+?)( unless (.+))?$/))) {
      const ds = m[1].split(',').map(x => iso(x.trim())); if (!ds.length || ds.some(x => !x)) { bad.push(line); continue; }
      out.push({ type: 'remind', dates: ds, unless: m[3] ? m[3].trim() : null, src: line }); continue;
    }
    if ((m = l.match(/^deadline (\d{1,2}\/\d{1,2}\/\d{4})$/))) { const d = iso(m[1]); out.push({ type: 'remind', dates: [addDays(d, -7), d], deadline: d, src: line }); continue; }
    bad.push(line);
  }
  out.forEach(x => { x.id = hash(x.src); });
  return { lines: out, bad };
}

/* ---------- data ---------- */
async function zohoContacts() {
  const tok = await Z.accessToken(), H = { Authorization: `Zoho-oauthtoken ${tok}` };
  // COQL first (one call); if this account's key can't use it, page through Contacts
  try {
    const r = await fetch(`${Z.urls().crm}/crm/v8/coql`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ select_query: "select Full_Name, PB_Rule, PB_Plan from Contacts where PB_Rule is not null limit 2000" }) });
    if (r.status === 204) return [];
    if (r.ok) { const j = await r.json(); return j.data || []; }
  } catch (e) {}
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`${Z.urls().crm}/crm/v8/Contacts?fields=Full_Name,PB_Rule,PB_Plan&per_page=200&page=${page}`, { headers: H });
    if (r.status === 204) break;
    if (!r.ok) throw new Error('Zoho CRM ' + r.status);
    const j = await r.json(); (j.data || []).forEach(c => c.PB_Rule && String(c.PB_Rule).trim() && out.push(c));
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

  let L = {}; try { L = await nse(); } catch (e) { notes.push('live: ' + e.message); }
  const H = {};
  await Promise.all(Object.entries(IDX).map(async ([k, [, s]]) => { try { H[k] = (await history(s)).filter(r => r[0] < T); } catch (e) { notes.push(k + ' history: ' + e.message); } }));
  const closes = (idx, a, b) => (H[idx] || []).filter(r => r[0] >= a && (!b || r[0] <= b)).map(r => r[1]);
  const ok = v => v != null && isFinite(v) && v > 0;

  const due = [];
  for (const c of contacts) {
    const name = c.Full_Name || 'Client', { lines, bad } = parseRule(c.PB_Rule);
    for (const b of bad) {
      const k = `${c.id}/bad-${hash(b)}`; if (last(k) === T) continue;
      badLines++; due.push({ c, k, title: `${name}: check this profit-booking rule line`, hit: `This line in PB Rule could not be read, so it is not being watched: "${b}". Fix it in Zoho CRM (see the formats in the "Profit booking alert rules" note).` });
    }
    for (const R of lines) {
      if (R.from && T < R.from) continue;
      if (R.until && T > R.until) continue;
      const base = `${c.id}/${R.id}`;
      if (R.type === 'at') {
        const n = Math.max(...R.alts.map(a => a.levels.length));
        for (let i = 0; i < n; i++) {
          const k = `${base}-p${i + 1}`; if (last(k)) continue;
          const a = R.alts.find(a => a.levels[i] && ok(L[a.idx]) && L[a.idx] >= a.levels[i]);
          if (a) due.push({ c, k, title: `${name}: ${LABEL[a.idx]} at ${fmt(a.levels[i])}, book part ${i + 1} of ${n}`, hit: `${LABEL[a.idx]} is at ${fmt(L[a.idx])}, at or above the level of ${fmt(a.levels[i])}.` });
        }
        continue;
      }
      if (R.type === 'remind') {
        R.dates.forEach(d => {
          const k = `${base}-${d}`; if (last(k) || T < d || T > addDays(d, 5)) return;
          if (R.unless) { const fired = lines.some(o => o !== R && o.src.toLowerCase().includes(R.unless.toLowerCase()) && Object.keys(keys).some(x => x.startsWith(`${c.id}/${o.id}`))); if (fired) return; }
          const dl = R.deadline ? (d === R.deadline ? `Deadline today (${dmy(d)})` : `Deadline in 7 days (${dmy(R.deadline)})`) : `Reminder for ${dmy(d)}`;
          due.push({ c, k, title: `${name}: ${dl.toLowerCase()}`, hit: `${dl}.` });
        });
        continue;
      }
      const k = base, lf = last(k);
      if (lf && !R.repeat) continue;
      if (lf === T) continue;
      const now = L[R.idx]; if (!ok(now)) continue;
      const lab = LABEL[R.idx];
      if (R.type === 'newHigh') {
        const cs = closes(R.idx, R.from); const hi = cs.length ? Math.max(...cs) : null;
        if (hi && now > hi) due.push({ c, k, title: `${name}: ${lab} at a new high`, hit: `${lab} is at ${fmt(now)}, above every close since ${dmy(R.from)} (best ${fmt(hi)}).` });
      } else if (R.type === 'fall') {
        if (R.close && !closedForDay) continue;
        const since = (R.repeat && lf) || R.from, cs = closes(R.idx, since); cs.push(now);
        const hi = Math.max(...cs);
        if (now <= hi * (1 - R.pct / 100)) due.push({ c, k, title: `${name}: ${lab} down ${R.pct}% from its high`, hit: `${lab} ${R.close ? 'closed' : 'is'} at ${fmt(now)}, ${((1 - now / hi) * 100).toFixed(1)}% below its high of ${fmt(hi)} since ${dmy(since)}.` });
      } else if (R.type === 'rise') {
        const since = lf || R.from, cs = closes(R.idx, since); if (!cs.length) continue;
        const lo = Math.min(...cs);
        if (now >= lo * (1 + R.pct / 100)) due.push({ c, k, title: `${name}: ${lab} up ${R.pct}% from its low`, hit: `${lab} is at ${fmt(now)}, up ${((now / lo - 1) * 100).toFixed(1)}% from its low of ${fmt(lo)} since ${dmy(since)}.` });
      } else if (R.type === 'aboveHigh') {
        const cs = closes(R.idx, addDays(R.from, -30), lf || addDays(R.from, -1)); if (!cs.length) continue;
        const hi = Math.max(...cs);
        if (now >= hi * (1 + R.pct / 100)) due.push({ c, k, title: `${name}: ${lab} ${R.pct}% above its earlier high`, hit: `${lab} is at ${fmt(now)}, ${((now / hi - 1) * 100).toFixed(1)}% above its earlier high of ${fmt(hi)}.` });
      }
    }
  }

  if (req.query && req.query.test) {                 // one clearly marked test alert, no memory key
    due.length = 0; due.push({ c: { id: 'test', PB_Plan: 'This is a test of the profit-booking alerts. Please mark this to-do complete.' }, k: 'test/test', title: 'TEST: profit-booking alert check', hit: 'Test only. Nothing to do.' });
  }
  for (const { c, k, title, hit } of due) {
    fired++;
    if (dry) continue;
    const plan = c.PB_Plan ? esc(c.PB_Plan).replace(/\n/g, '<br>') : '';
    const body = `<div><strong>Trigger reached, review for profit booking.</strong></div><div>${esc(hit)}</div>${plan ? `<div><br>Plan: ${plan}</div>` : ''}<div><br>Check exit load and short-term tax on units held under a year before redeeming.</div>${k === 'test/test' ? '' : `<div><br>pb-key: ${k}/${T}</div>`}`;
    let todo;
    try { todo = await B.createTodo(title, body, T); } catch (e) { notes.push('basecamp: ' + e.message); continue; }   // no to-do → no email, so the memory stays consistent
    try {
      const ACC = Z.env('ZOHO_MAIL_ACCOUNT_ID'), FROM = Z.env('FROM_ADDRESS'), tok = await Z.accessToken();
      const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:15px;color:#39293E">
        <p style="font-size:17px;color:#005826"><b>${esc(title)}</b></p><p><b>Trigger reached, review for profit booking.</b><br>${esc(hit)}</p>
        ${plan ? `<p>Plan: ${plan}</p>` : ''}<p>Check exit load and short-term tax on units held under a year before redeeming.</p>
        <p><a href="${todo.app_url}">Open the Basecamp to-do</a> · <a href="https://abundance-dashboard-beta.vercel.app/Market_Pulse.html">Market Pulse</a></p>
        <p style="color:#6f6875;font-size:12px">Sent automatically by the Abundance dashboard from the PB Rule field in Zoho CRM. Internal reminder, not investment advice.</p></div>`;
      const r = await fetch(`${Z.urls().mail}/api/accounts/${ACC}/messages`, { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAddress: FROM, toAddress: TO, subject: 'Profit booking alert · ' + title, content: html, mailFormat: 'html', askReceipt: 'no' }) });
      if (r.ok) sent++; else notes.push('mail ' + r.status);
    } catch (e) { notes.push('mail: ' + e.message); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return Z.reply(res, 200, { ok: true, dry, clients: contacts.length, due: fired, unreadableLines: badLines, emailed: sent, live: L, notes });
};

module.exports.parseRule = parseRule;
