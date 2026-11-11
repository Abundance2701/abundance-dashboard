/* NSE's official MCP servers (https://www.nseindia.com/nse-mcp), called server-side.
   Free, no login or key. Two servers:
     live : https://mcp.nseindia.in/cmmkt/mcp          live index values (1-3 min delay), stock quotes, gainers/losers
     eod  : https://mcp.nseindia.in/bhavcopy/cm/mcp    end-of-day closes, 5 years, index history (12 months per call)
   NSE terms: information only, not for commercial products. We use it for internal tools and alerts;
   client documents cite "Source: NSE, as of DD/MM/YYYY" and carry no bulk tables.
   call('live', 'cm_get_live_indices', {...}) → the tool's JSON result. Throws on any failure so callers can fall back. */

const URLS = { live: 'https://mcp.nseindia.in/cmmkt/mcp', eod: 'https://mcp.nseindia.in/bhavcopy/cm/mcp' };
const sessions = {};          // server → Mcp-Session-Id (reused while the function instance stays warm)
const inits = {};             // server → handshake in progress
let seq = 0;

function parseBody(text, ctype) {
  if (/event-stream/i.test(ctype || '')) {          // streamable HTTP may answer as server-sent events
    let last = null;
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5).trim()); if (j && (j.result || j.error)) last = j; } catch (e) {} }
    if (!last) throw new Error('empty event stream');
    return last;
  }
  return text ? JSON.parse(text) : {};
}

async function post(server, body, ms) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
  if (sessions[server] && sessions[server] !== '-') h['Mcp-Session-Id'] = sessions[server];
  const r = await fetch(URLS[server], { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  const sid = r.headers.get('mcp-session-id'); if (sid) sessions[server] = sid;
  const text = await r.text();
  if (r.status === 404 && sessions[server] && sessions[server] !== '-') { delete sessions[server]; const e = new Error('session expired'); e.retry = true; throw e; }
  if (!r.ok) throw new Error(`nse-mcp ${server} ${r.status} ${text.slice(0, 120)}`);
  return body.id == null ? null : parseBody(text, r.headers.get('content-type'));
}

async function init(server, ms) {
  const j = await post(server, { jsonrpc: '2.0', id: ++seq, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'abundance-dashboard', version: '1' } } }, ms);
  if (j.error) throw new Error('nse-mcp init: ' + j.error.message);
  if (!sessions[server]) sessions[server] = '-';      // stateless server: no session id to send
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, ms).catch(() => {});
}

async function rpc(server, method, params, ms = 9000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!sessions[server]) {                        // one handshake per server, shared by calls made in parallel
        inits[server] = inits[server] || init(server, ms).finally(() => { delete inits[server]; });
        await inits[server];
      }
      const j = await post(server, { jsonrpc: '2.0', id: ++seq, method, params }, ms);
      if (j.error) throw new Error(`nse-mcp ${method}: ${j.error.message}`);
      return j.result;
    } catch (e) { if (!e.retry || attempt) throw e; }
  }
}

async function call(server, tool, args, ms) {
  const res = await rpc(server, 'tools/call', { name: tool, arguments: args || {} }, ms);
  if (res && res.structuredContent) return res.structuredContent;
  const t = ((res && res.content) || []).filter(c => c.type === 'text').map(c => c.text).join('');
  if (res && res.isError) throw new Error(`nse-mcp ${tool}: ${t.slice(0, 160)}`);
  try { return JSON.parse(t); } catch (e) { throw new Error(`nse-mcp ${tool}: not JSON: ${t.slice(0, 120)}`); }
}

const listTools = server => rpc(server, 'tools/list', {});

module.exports = { call, listTools, URLS };
