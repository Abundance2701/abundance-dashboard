/* GET /api/events  → what's coming up in the next ~2 weeks, from NSE's public website data:
   - IPOs open now or opening soon (mainboard only; SME issues left out)
   - quarterly results board meetings of Nifty 100 companies (the stocks most MF portfolios hold)
   - NSE trading holidays
   Economic data dates (CPI, WPI, GDP, RBI/Fed meetings) are not published by NSE; the page adds
   them from data/calendar.json. NSE sometimes refuses cloud servers: then this returns an empty
   list with a note, and the page still shows the calendar file. Cached 1 hour. No secrets used. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = t => { const m = String(t || '').match(/(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})/); return m && MON[m[2].toLowerCase()] ? `${m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const arr = x => Array.isArray(x) ? x : x && Array.isArray(x.data) ? x.data : [];

async function session() {
  const h = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(6000) });
  const set = typeof h.headers.getSetCookie === 'function' ? h.headers.getSetCookie() : [h.headers.get('set-cookie') || ''];
  const cookie = set.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  return async p => {
    const r = await fetch('https://www.nseindia.com/api/' + p, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/', Cookie: cookie }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error(p.split('?')[0] + ' ' + r.status);
    return r.json();
  };
}

module.exports = async (req, res) => {
  const notes = [], out = [];
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const until = new Date(Date.now() + 5.5 * 3600e3 + 15 * 864e5).toISOString().slice(0, 10);
  const inWin = d => d && d >= today && d <= until;
  try {
    const get = await session();
    const [cur, up, cal, n100, hol] = await Promise.allSettled([
      get('ipo-current-issue'), get('all-upcoming-issues?category=ipo'), get('event-calendar'),
      get('equity-stockIndices?index=' + encodeURIComponent('NIFTY 100')), get('holiday-master?type=trading')]);
    [cur, up, cal, n100, hol].forEach(x => x.status === 'rejected' && notes.push(String(x.reason.message || x.reason)));

    // IPOs: one line per issue, dated by its closing day (or opening day if it hasn't opened yet)
    const seen = new Set();
    [cur, up].forEach(x => x.status === 'fulfilled' && arr(x.value).forEach(i => {
      const name = i.companyName || i.company || i.symbol; if (!name || seen.has(name)) return;
      if (/sme/i.test(i.series || i.issueType || '')) return;
      const o = iso(i.issueStartDate), c = iso(i.issueEndDate); if (!c) return;
      const open = o && o <= today;
      const d = open ? c : o;
      if (!inWin(d) && !(open && c >= today)) return;
      seen.add(name);
      const price = i.issuePrice || i.priceBand || '';
      out.push({ date: open ? c : o, type: 'IPO', title: `${name} IPO ${open ? 'closes' : 'opens'}`,
        note: [o && c ? `Open ${o.split('-').reverse().join('/')}–${c.split('-').reverse().join('/')}` : '', price ? `price ${String(price).replace(/\s+/g, ' ')}` : '', i.noOfTime ? `subscribed ${i.noOfTime}×` : ''].filter(Boolean).join(' · ') });
    }));

    // Results of Nifty 100 companies
    const big = new Set(n100.status === 'fulfilled' ? arr(n100.value).map(x => x.symbol).filter(Boolean) : []);
    if (cal.status === 'fulfilled') {
      const byDay = {};
      arr(cal.value).forEach(e => {
        const d = iso(e.date || e.bm_date); if (!inWin(d)) return;
        if (!/result/i.test((e.purpose || '') + ' ' + (e.bm_purpose || '') + ' ' + (e.bm_desc || ''))) return;
        if (big.size && !big.has(e.symbol)) return;
        (byDay[d] = byDay[d] || new Set()).add(e.company || e.symbol);
      });
      Object.entries(byDay).forEach(([d, s]) => { const L = [...s]; out.push({ date: d, type: 'Results', title: `Q results: ${L.slice(0, 4).join(', ')}${L.length > 4 ? ` +${L.length - 4} more` : ''}`, note: L.length > 4 ? L.join(', ') : 'Board meetings to consider quarterly results (NSE event calendar).' }); });
    }

    // Trading holidays
    if (hol.status === 'fulfilled') (hol.value.CM || hol.value.FO || []).forEach(h => { const d = iso(h.tradingDate); if (inWin(d)) out.push({ date: d, type: 'Holiday', title: `Market holiday: ${h.description || ''}`.trim(), note: 'NSE and BSE closed.' }); });
  } catch (e) { notes.push('nse: ' + (e.message || e)); }
  out.sort((a, b) => a.date.localeCompare(b.date));
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify({ updated: new Date().toISOString(), events: out, notes }));
};
