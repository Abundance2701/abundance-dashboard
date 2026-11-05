/* GET /api/movers  → what is moving the Nifty right now.
   - Nifty 50 open / high / low / last, advances and declines, sector indices  (NSE allIndices)
   - each Nifty 50 stock's move and its contribution in index points            (NSE index page data)
     Points = stock's free-float weight × its % move × yesterday's Nifty close, which is how NSE
     itself calculates the index, so the contributions add up to the Nifty's actual move.
   - if NSE refuses the stock list from cloud servers: Yahoo Finance prices for the 50 stocks
     (list from NSE's index CSV), % move only, no points; "source" says which was used.
   - Nifty's intraday path (5-minute bars, Yahoo) for the small chart.
   Cached 20 seconds. No secrets used. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const SECTORS = ['NIFTY BANK', 'NIFTY PRIVATE BANK', 'NIFTY PSU BANK', 'NIFTY FINANCIAL SERVICES', 'NIFTY IT', 'NIFTY AUTO', 'NIFTY FMCG', 'NIFTY PHARMA',
  'NIFTY HEALTHCARE INDEX', 'NIFTY METAL', 'NIFTY ENERGY', 'NIFTY OIL & GAS', 'NIFTY REALTY', 'NIFTY MEDIA', 'NIFTY CONSUMER DURABLES', 'NIFTY INDIA DEFENCE', 'NIFTY CAPITAL MARKETS'];
const nice = s => s.replace(/^NIFTY /, '').replace(/ INDEX$/, '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bIt\b/, 'IT').replace(/\bFmcg\b/, 'FMCG').replace(/\bPsu\b/, 'PSU').replace(/ & /g, ' & ');
// the largest Nifty 50 weights (they move the index most); shown as their own row
const HEAVY = ['HDFCBANK', 'RELIANCE', 'ICICIBANK', 'INFY', 'BHARTIARTL', 'LT', 'ITC', 'TCS', 'AXISBANK', 'SBIN'];
const short = n => String(n || '').replace(/\s+(limited|ltd\.?)$/i, '').replace(/^the /i, '').trim();

async function nseSession() {
  const h = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) });
  const set = typeof h.headers.getSetCookie === 'function' ? h.headers.getSetCookie() : [h.headers.get('set-cookie') || ''];
  const cookie = set.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  return async p => {
    const r = await fetch('https://www.nseindia.com/api/' + p, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', Referer: 'https://www.nseindia.com/market-data/live-equity-market', Cookie: cookie }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error(p.split('?')[0] + ' ' + r.status);
    return r.json();
  };
}
async function yq(sym, range = '1d', interval = '5m') {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('yahoo ' + sym + ' ' + r.status);
  return (await r.json()).chart.result[0];
}

module.exports = async (req, res) => {
  const notes = [];
  let get = null; try { get = await nseSession(); } catch (e) { notes.push('nse session: ' + (e.message || e)); }
  const [all, cons, path] = await Promise.allSettled([
    get ? get('allIndices') : Promise.reject(new Error('no nse')),
    get ? get('equity-stockIndices?index=' + encodeURIComponent('NIFTY 50')) : Promise.reject(new Error('no nse')),
    yq('^NSEI')]);
  [all, cons, path].forEach(x => x.status === 'rejected' && notes.push(String(x.reason.message || x.reason)));

  // index level, range, breadth, sectors
  const map = {};
  if (all.status === 'fulfilled') (all.value.data || []).forEach(x => { map[String(x.index).toUpperCase()] = x; });
  const n = map['NIFTY 50'];
  const nifty = n ? { last: +n.last, prev: +n.previousClose, open: +n.open, high: +n.high, low: +n.low, chgPct: r2(+n.percentChange),
    adv: +n.advances || null, dec: +n.declines || null, unch: +n.unchanged || null, asOf: all.value.timestamp || null } : null;
  const sectors = SECTORS.filter(k => map[k] && isFinite(+map[k].percentChange)).map(k => ({ name: nice(k), pct: r2(+map[k].percentChange) })).sort((a, b) => b.pct - a.pct);
  const broad = ['NIFTY MIDCAP 150', 'NIFTY SMALLCAP 250', 'INDIA VIX'].filter(k => map[k]).map(k => ({ name: nice(k).replace('India Vix', 'India VIX'), pct: r2(+map[k].percentChange), last: +map[k].last }));

  // stocks
  let stocks = [], source = '';
  if (cons.status === 'fulfilled') {
    const rows = (cons.value.data || []).filter(x => x.priority !== 1 && x.symbol && x.symbol !== 'NIFTY 50' && isFinite(+x.pChange));
    const base = rows.map(x => { const r = +x.pChange / 100, ff = +x.ffmc || 0; return ff / (1 + r); });
    const tot = base.reduce((a, b) => a + b, 0);
    const prev = nifty ? nifty.prev : +((cons.value.data || []).find(x => x.priority === 1) || {}).previousClose;
    stocks = rows.map((x, i) => ({ sym: x.symbol, name: short((x.meta && x.meta.companyName) || x.symbol), industry: (x.meta && x.meta.industry) || '',
      last: r2(+x.lastPrice), pct: r2(+x.pChange), pts: tot && prev ? r2(base[i] / tot * (+x.pChange / 100) * prev) : null }));
    source = 'NSE';
    if (!tot) notes.push('weights unavailable');
  } else {
    // fallback: Nifty 50 list from the official CSV, prices from Yahoo
    let list = [];
    for (const u of ['https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv', 'https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv']) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }); if (!r.ok) continue;
        const rows = (await r.text()).trim().split(/\r?\n/).map(l => l.split(','));
        const ks = rows[0].findIndex(h => /symbol/i.test(h)), kn = rows[0].findIndex(h => /company/i.test(h)), ki = rows[0].findIndex(h => /industry/i.test(h));
        list = rows.slice(1).filter(c => c[ks]).map(c => ({ sym: c[ks].trim(), name: short(c[kn]), industry: ki >= 0 ? c[ki] : '' }));
        if (list.length > 40) break;
      } catch (e) {}
    }
    const qs = await Promise.allSettled(list.map(s => yq(s.sym + '.NS', '1d', '15m')));
    stocks = list.map((s, i) => {
      if (qs[i].status !== 'fulfilled') return null;
      const m = qs[i].value.meta, p = m.chartPreviousClose || m.previousClose, l = m.regularMarketPrice;
      return p && l ? { ...s, last: r2(l), pct: r2((l / p - 1) * 100), pts: null, t: m.regularMarketTime ? m.regularMarketTime * 1000 : null } : null;
    }).filter(Boolean);
    source = stocks.length ? 'Yahoo Finance (may lag up to 15 min; points not available)' : '';
    if (!stocks.length) notes.push('no stock data');
  }
  const key = s => s.pts != null ? s.pts : s.pct;
  stocks.sort((a, b) => key(b) - key(a));
  const up = stocks.filter(s => key(s) > 0).slice(0, 6), down = stocks.filter(s => key(s) < 0).slice(-6).reverse();
  const heavy = HEAVY.map(h => stocks.find(s => s.sym === h)).filter(Boolean);
  const ptsSum = stocks.every(s => s.pts != null) ? r2(stocks.reduce((a, s) => a + s.pts, 0)) : null;

  // intraday path for the chart
  let intraday = null;
  if (path.status === 'fulfilled') {
    const p = path.value, q = p.indicators.quote[0];
    intraday = { prev: p.meta.chartPreviousClose || p.meta.previousClose || null, pts: p.timestamp.map((t, i) => [t * 1000, q.close[i]]).filter(x => x[1] != null).map(([t, v]) => [t, r2(v)]) };
  }

  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify({ updated: new Date().toISOString(), nifty, broad, sectors, up, down, heavy, count: stocks.length, ptsSum, source, intraday, notes }));
};
