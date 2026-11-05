/* GET /api/pb-check  → checks every client's profit-booking rule against the live market and, when a
   rule is newly met, creates a Basecamp to-do for Haritha in "Profit booking clients" and emails
   service@abundanceindia.com. Called every 15 minutes in market hours by .github/workflows/pb-check.yml.
   - Rules: the "Profit booking alert rules" message on the Investments → ✏ Notes board (private).
   - Memory: each alert to-do carries a "pb-key" line; a rule never alerts twice for the same key.
   - Market: Nifty 50 / Nifty 500 live from NSE, past closes from Yahoo. If live data is missing,
     no market alert is sent (never a false alarm). The reply holds counts only, never client names.
   Add ?dry=1 to see what would fire without sending anything (still no names in the reply). */

const B = require('./_bc');
const Z = require('./_zoho');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TO = 'service@abundanceindia.com';
const YSYM = { 'NIFTY 50': '^NSEI', 'NIFTY 500': '^CRSLDX' };
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
const today = () => istNow().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dmy = d => d.split('-').reverse().join('/');
const fmt = v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

async function live() {
  const h = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(6000) });
  const ck = (h.headers.getSetCookie ? h.headers.getSetCookie() : [h.headers.get('set-cookie') || '']).map(c => c.split(';')[0]).join('; ');
  const r = await fetch('https://www.nseindia.com/api/allIndices', { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/', Cookie: ck }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('nse ' + r.status);
  const j = await r.json(), out = {};
  (j.data || []).forEach(x => { const k = String(x.index).toUpperCase(); if (YSYM[k]) out[k] = +x.last; });
  out.ts = j.timestamp || '';
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
  const closedForDay = wd === 0 || wd === 6 || mins >= 15 * 60 + 31;   // today's figure is the close
  const notes = []; let fired = 0, sent = 0;
  let rules, todos;
  try { [rules, todos] = await Promise.all([B.rules(), B.alertTodos()]); }
  catch (e) { return Z.reply(res, 200, { ok: false, error: e.message }); }
  const keys = {};                                       // "rule/part" → [dates fired]
  todos.forEach(t => { (String(t.description || '').match(/pb-key:\s*([\w\-]+\/[\w\-]+)\/(\d{4}-\d{2}-\d{2})/g) || []).forEach(m => {
    const [, k, d] = m.match(/pb-key:\s*([\w\-]+\/[\w\-]+)\/(\d{4}-\d{2}-\d{2})/); (keys[k] = keys[k] || []).push(d); }); });
  const last = k => (keys[k] || []).sort().slice(-1)[0] || null;

  let L = null; try { L = await live(); } catch (e) { notes.push('live: ' + e.message); }
  const H = {};
  await Promise.all(Object.entries(YSYM).map(async ([k, s]) => { try { H[k] = (await history(s)).filter(r => r[0] < T); } catch (e) { notes.push(k + ' history: ' + e.message); } }));
  const closes = (idx, from) => (H[idx] || []).filter(r => r[0] >= from).map(r => r[1]);

  const due = [];
  for (const R of rules) {
    const idx = R.index || 'NIFTY 50', now = L && L[idx];
    for (const P of R.parts || []) {
      const k = `${R.id}/${P.id}`, lf = last(k);
      if (lf && !P.repeat) continue;                     // one-time part already alerted
      if (lf === T) continue;                            // at most once a day
      if (P.from && T < P.from) continue;
      if (P.until && T > P.until) continue;
      let hit = null;
      const mkt = v => v != null && isFinite(v);
      if (P.type === 'level') { if (mkt(now) && now >= P.level) hit = `${idx} at ${fmt(now)}, at or above your level of ${fmt(P.level)}.`; }
      else if (P.type === 'newHigh') {                    // above every close since a date
        const c = closes(idx, P.since); const hi = c.length ? Math.max(...c) : null;
        if (mkt(now) && hi && now > hi) hit = `${idx} at ${fmt(now)}, a new high since ${dmy(P.since)} (previous best close ${fmt(hi)}).`;
      } else if (P.type === 'fall') {                     // fall from the highest close since a date / since the last alert
        if (P.close && !closedForDay) continue;
        const base = (P.repeat && lf) || P.since, c = closes(idx, base); if (mkt(now)) c.push(now);
        const hi = c.length ? Math.max(...c) : null;
        if (mkt(now) && hi && now <= hi * (1 - P.pct / 100)) hit = `${idx} ${P.close ? 'closed' : 'is'} at ${fmt(now)}, ${((1 - now / hi) * 100).toFixed(1)}% below its high of ${fmt(hi)} since ${dmy(base)}.`;
      } else if (P.type === 'rise') {                     // rise from the lowest close since a date / since the last alert
        const base = lf || P.since, c = closes(idx, base); const lo = c.length ? Math.min(...c) : null;
        if (mkt(now) && lo && now >= lo * (1 + P.pct / 100)) hit = `${idx} at ${fmt(now)}, up ${((now / lo - 1) * 100).toFixed(1)}% from its low of ${fmt(lo)} since ${dmy(base)}.`;
      } else if (P.type === 'aboveHigh') {                // P.pct above the highest close up to the last alert (or up to P.from)
        const end = lf || addDays(P.from || T, -1); const c = (H[idx] || []).filter(r => r[0] >= P.since && r[0] <= end).map(r => r[1]);
        const hi = c.length ? Math.max(...c) : null;
        if (mkt(now) && hi && now >= hi * (1 + P.pct / 100)) hit = `${idx} at ${fmt(now)}, ${((now / hi - 1) * 100).toFixed(1)}% above its earlier high of ${fmt(hi)}.`;
      } else if (P.type === 'date') {                     // reminder on a date, optionally only if another part never fired
        if (T >= P.date && T <= addDays(P.date, 5) && !(P.unless && last(`${R.id}/${P.unless}`))) hit = `Reminder for ${dmy(P.date)}.`;
      } else if (P.type === 'quarter') {                  // on each date, unless a market alert fired in the last 45 days
        const d = (P.dates || []).filter(x => x <= T && T <= addDays(x, 5)).slice(-1)[0];
        const recent = last(`${R.id}/${P.unless}`);
        if (d && !(keys[k] || []).some(x => x >= d) && !(recent && recent >= addDays(T, -45))) hit = `Quarter-end check (${dmy(d)}): no market alert in the last 45 days.`;
      }
      if (!hit) continue;
      due.push({ R, P, k, hit });
    }
  }

  for (const { R, P, k, hit } of due) {
    fired++;
    if (dry) continue;
    const title = `${R.client}: ${P.text}`;
    const body = `<div><strong>Trigger reached, review for profit booking.</strong></div><div>${hit}</div>${R.note ? `<div>Plan: ${R.note}</div>` : ''}${R.deadline ? `<div>Deadline: ${R.deadline}</div>` : ''}<div><br>Check exit load and short-term tax on units held under a year before redeeming.</div><div><br>pb-key: ${k}/${T}</div>`;
    let todo = null;
    try { todo = await B.createTodo(title, body, T); } catch (e) { notes.push('basecamp: ' + e.message); continue; }   // no to-do → no email (keeps the memory consistent)
    try {
      const ACC = Z.env('ZOHO_MAIL_ACCOUNT_ID'), FROM = Z.env('FROM_ADDRESS'), tok = await Z.accessToken();
      const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:15px;color:#39293E">
        <p style="font-size:17px;color:#005826"><b>${title}</b></p><p><b>Trigger reached, review for profit booking.</b><br>${hit}</p>
        ${R.note ? `<p>Plan: ${R.note}</p>` : ''}${R.deadline ? `<p>Deadline: ${R.deadline}</p>` : ''}
        <p>Check exit load and short-term tax on units held under a year before redeeming.</p>
        <p><a href="${todo.app_url}">Open the Basecamp to-do</a> · <a href="https://abundance-dashboard-beta.vercel.app/Market_Pulse.html">Market Pulse</a></p>
        <p style="color:#6f6875;font-size:12px">Sent automatically by the Abundance dashboard. Internal reminder, not investment advice.</p></div>`;
      const r = await fetch(`${Z.urls().mail}/api/accounts/${ACC}/messages`, { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromAddress: FROM, toAddress: TO, subject: 'Profit booking alert · ' + title, content: html, mailFormat: 'html', askReceipt: 'no' }) });
      if (r.ok) sent++; else notes.push('mail ' + r.status);
    } catch (e) { notes.push('mail: ' + e.message); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return Z.reply(res, 200, { ok: true, dry, rules: rules.length, fired, emailed: sent, live: L ? { nifty50: L['NIFTY 50'], nifty500: L['NIFTY 500'], at: L.ts } : null, notes });
};
