/* GET /api/nse-ping → can this Vercel server reach NSE's MCP? Lists each server's tools and makes one call on each.
   No secrets; read-only. Used to test the connection before switching tools to NSE's data. */
const N = require('./_nsemcp');
module.exports = async (req, res) => {
  const out = {};
  for (const s of ['live', 'eod']) {
    const t0 = Date.now();
    try {
      const l = await N.listTools(s);
      out[s] = { ok: true, ms: Date.now() - t0, tools: (l.tools || []).map(t => t.name) };
      const t1 = Date.now();
      out[s].sample = s === 'live'
        ? await N.call('live', 'cm_get_live_indices', { group: 'broad', nameFilter: 'NIFTY 50' })
        : await N.call('eod', 'get_index_history', { indexName: 'Nifty 50', months: 1, endDate: 'today' });
      if (s === 'eod' && out[s].sample && Array.isArray(out[s].sample.data)) out[s].sample.data = out[s].sample.data.slice(0, 2);
      out[s].sampleMs = Date.now() - t1;
    } catch (e) { out[s] = { ok: false, ms: Date.now() - t0, error: String(e.message || e) }; }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
};
