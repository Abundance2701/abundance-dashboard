/* GET /api/market  → live index levels, day's move, 1W–1Y returns, and FII/DII cash figures.
   Indian indices + India VIX + FII/DII: NSE's public website data (needs a cookie from the home page).
   Sensex, S&P 500 and the return history: Yahoo Finance daily closes.
   If NSE refuses (it sometimes blocks cloud servers), Yahoo figures are used and "source" says so.
   Cached at the edge for 60 seconds. No secrets used. */

const IDX = [
  // name, Yahoo symbol, NSE index name
  ['Nifty 50', '^NSEI', 'NIFTY 50'],
  ['Sensex', '^BSESN', null],
  ['Bank Nifty', '^NSEBANK', 'NIFTY BANK'],
  ['Nifty Midcap 150', 'NIFTYMIDCAP150.NS', 'NIFTY MIDCAP 150'],
  ['Nifty Smallcap 250', 'NIFTYSMLCAP250.NS', 'NIFTY SMALLCAP 250'],
  ['Nifty IT', '^CNXIT', 'NIFTY IT'],
  ['India VIX', '^INDIAVIX', 'INDIA VIX'],
  ['S&P 500', '^GSPC', null],
];
// Precious metals: international spot price converted to rupees (the same thing as TradingView's
// XAUINRG / XAGINR), shown per 10 g and per kg. Yahoo spot symbols first, COMEX futures as fallback;
// the latest level is replaced by a live spot quote from gold-api.com when it is available.
const OZ = 31.1034768;
const METALS = { gold: ['XAUUSD=X', 'GC=F'], silver: ['XAGUSD=X', 'SI=F'], fx: ['INR=X'] };
async function firstOk(list) { for (const s of list) { try { const y = await yahoo(s); if (y.rows.length > 30) return { ...y, sym: s }; } catch (e) {} } return null; }
async function spotNow(sym) {
  try { const r = await fetch('https://api.gold-api.com/price/' + sym, { signal: AbortSignal.timeout(5000) }); if (!r.ok) return null; const j = await r.json(); return isFinite(+j.price) && +j.price > 0 ? +j.price : null; } catch (e) { return null; }
}
function card(name, rows, srcNote) {
  if (!rows || rows.length < 2) return null;
  const level = rows[rows.length - 1][1], prev = rows[rows.length - 2][1], chg = level - prev;
  return { name, level: r2(level), chg: r2(chg), chgPct: r2(chg / prev * 100), date: rows[rows.length - 1][0], perf: rows.length > 30 ? perf(rows, level) : {}, spark: rows.slice(-22).map(r => r2(r[1])), src: srcNote, metal: true };
}
async function metals(notes) {
  const [g, sv, fx, gs, ss] = await Promise.all([firstOk(METALS.gold), firstOk(METALS.silver), firstOk(METALS.fx), spotNow('XAU'), spotNow('XAG')]);
  if (!g || !sv || !fx) { notes.push('metals: ' + [!g && 'gold', !sv && 'silver', !fx && 'USD/INR'].filter(Boolean).join(', ') + ' unavailable'); return []; }
  const fxAt = (() => { const m = new Map(fx.rows); const ds = fx.rows.map(r => r[0]); return d => { if (m.has(d)) return m.get(d); let v = null; for (const x of ds) { if (x <= d) v = m.get(x); else break; } return v; }; })();
  const fix = (y, live) => { const rows = y.rows.slice(); if (live && rows.length) { const ref = rows[rows.length - 1][1]; if (Math.abs(live / ref - 1) < 0.08) rows[rows.length - 1] = [rows[rows.length - 1][0], live]; } return rows; };
  const gU = fix(g, gs), sU = fix(sv, ss);
  const inr = (rows, k) => rows.map(([d, v]) => [d, fxAt(d) ? v / OZ * k * fxAt(d) : null]).filter(r => r[1] != null);
  const sMap = new Map(sU);
  const ratio = gU.filter(([d]) => sMap.has(d)).map(([d, v]) => [d, v / sMap.get(d)]);
  const how = y => (/=X$/.test(y.sym) ? 'international spot' : 'COMEX futures') + ((y === g ? gs : ss) ? ', live spot from gold-api.com' : '') + ' × USD/INR (Yahoo)';
  return [card('Gold · ₹/10 g', inr(gU, 10), how(g)), card('Silver · ₹/kg', inr(sU, 1000), how(sv)), card('Gold/Silver ratio', ratio, 'gold ÷ silver, both in $/oz')].filter(Boolean);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;

async function yahoo(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`;
  const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const res = (await r.json()).chart.result[0], m = res.meta, off = (m.gmtoffset || 0) * 1000;
  const day = t => new Date(t * 1000 + off).toISOString().slice(0, 10);
  const rows = res.timestamp.map((t, i) => [day(t), res.indicators.quote[0].close[i]]).filter(r => r[1] != null);
  if (m.regularMarketPrice != null && m.regularMarketTime) {
    const d = day(m.regularMarketTime);
    if (rows.length && rows[rows.length - 1][0] === d) rows[rows.length - 1][1] = m.regularMarketPrice; else rows.push([d, m.regularMarketPrice]);
  }
  return { rows, time: m.regularMarketTime ? m.regularMarketTime * 1000 : null };
}

function perf(rows, level) {
  const [d, ] = rows[rows.length - 1], last = new Date(d + 'T00:00:00Z');
  const at = days => { const c = new Date(last - days * 864e5).toISOString().slice(0, 10); let v = null; for (const [dd, x] of rows) { if (dd <= c) v = x; else break; } return v; };
  const ytdBase = (() => { let v = null; for (const [dd, x] of rows) { if (dd < d.slice(0, 4) + '-01-01') v = x; else break; } return v; })();
  const ret = b => b ? r2((level / b - 1) * 100) : null;
  return { '1W': ret(at(7)), '1M': ret(at(30)), '3M': ret(at(91)), '6M': ret(at(182)), YTD: ret(ytdBase), '1Y': ret(at(365)) };
}

async function nse() {
  const h = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) });
  const set = typeof h.headers.getSetCookie === 'function' ? h.headers.getSetCookie() : [h.headers.get('set-cookie') || ''];
  const cookie = set.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  const get = async p => {
    const r = await fetch('https://www.nseindia.com/api/' + p, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/', Cookie: cookie }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('nse ' + p + ' ' + r.status);
    return r.json();
  };
  const [ai, fd] = await Promise.allSettled([get('allIndices'), get('fiidiiTradeReact')]);
  return { all: ai.status === 'fulfilled' ? ai.value : null, fiidii: fd.status === 'fulfilled' ? fd.value : null, err: [ai, fd].filter(x => x.status === 'rejected').map(x => String(x.reason.message || x.reason)) };
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const nseDate = t => { const m = String(t || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/); return m ? `${m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

module.exports = async (req, res) => {
  const notes = [];
  const [ys, ns, mt] = await Promise.all([Promise.allSettled(IDX.map(([, s]) => yahoo(s))), nse().catch(e => ({ err: [String(e.message || e)] })), metals(notes).catch(e => (notes.push('metals: ' + e.message), []))]);
  (ns.err || []).forEach(e => notes.push(e));
  const nmap = {};
  ((ns.all && ns.all.data) || []).forEach(x => { nmap[String(x.index || x.indexSymbol).toUpperCase()] = x; });
  const indices = [];
  IDX.forEach(([name, sym, nseName], i) => {
    const y = ys[i].status === 'fulfilled' ? ys[i].value : null;
    if (!y && !nmap[nseName]) { notes.push(name + ': no data'); return; }
    const n = nseName && nmap[nseName];
    let rows = y ? y.rows.slice() : [];
    let level, prev, src;
    if (n && isFinite(+n.last)) {
      level = +n.last; prev = +n.previousClose; src = 'NSE';
      // put NSE's live level in place of Yahoo's latest bar so returns use the same number
      const nd = nseDate(ns.all.timestamp) || new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      if (rows.length) { if (rows[rows.length - 1][0] === nd) rows[rows.length - 1][1] = level; else if (rows[rows.length - 1][0] < nd) rows.push([nd, level]); }
    } else { level = rows[rows.length - 1][1]; prev = rows.length > 1 ? rows[rows.length - 2][1] : null; src = 'Yahoo'; }
    const chg = prev ? level - prev : null;
    indices.push({ name, asOf: src === 'NSE' ? (ns.all.timestamp || null) : (y && y.time ? new Date(y.time).toISOString() : null), level: r2(level), chg: r2(chg), chgPct: prev ? r2(chg / prev * 100) : null, date: rows.length ? rows[rows.length - 1][0] : null,
      perf: rows.length > 30 ? perf(rows, level) : {}, spark: rows.slice(-22).map(r => r2(r[1])), src });
  });
  indices.push(...mt);
  let fiidii = null;
  if (Array.isArray(ns.fiidii) && ns.fiidii.length) {
    const pick = re => ns.fiidii.find(x => re.test(x.category || ''));
    const f = pick(/FII|FPI/i), d = pick(/DII/i);
    fiidii = { date: (f || d || {}).date || null, fii: f ? r2(+f.netValue) : null, dii: d ? r2(+d.netValue) : null,
      fiiBuy: f ? r2(+f.buyValue) : null, fiiSell: f ? r2(+f.sellValue) : null, diiBuy: d ? r2(+d.buyValue) : null, diiSell: d ? r2(+d.sellValue) : null, src: 'NSE (provisional)' };
  }
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify({ updated: new Date().toISOString(), indices, fiidii, notes }));
};
