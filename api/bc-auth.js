/* GET /api/bc-auth  → one-time Basecamp connection for the profit-booking alerts.
   1. Opens Basecamp's "allow access" page (you sign in to Basecamp yourself).
   2. Basecamp sends you back here with a code; this page swaps it for a refresh token and
      shows it once, so you can paste it into Vercel as BC_REFRESH_TOKEN. Nothing is stored here. */
const { env, UA, redirectUri } = require('./_bc');
const page = (res, body) => { res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Basecamp connection</title><body style="font:16px/1.5 Calibri,Carlito,Arial,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#39293E;background:#F6F2E7">${body}</body>`); };
module.exports = async (req, res) => {
  const id = env('BC_CLIENT_ID'), secret = env('BC_CLIENT_SECRET');
  if (!id || !secret) return page(res, '<h2>Almost there</h2><p>Add <b>BC_CLIENT_ID</b> and <b>BC_CLIENT_SECRET</b> in Vercel → Settings → Environment Variables, redeploy, then open this page again.</p>');
  const code = req.query && req.query.code;
  if (!code) {
    const q = new URLSearchParams({ type: 'web_server', client_id: id, redirect_uri: redirectUri() });
    res.statusCode = 302; res.setHeader('Location', 'https://launchpad.37signals.com/authorization/new?' + q); return res.end();
  }
  const q = new URLSearchParams({ type: 'web_server', client_id: id, client_secret: secret, redirect_uri: redirectUri(), code: String(code) });
  const r = await fetch('https://launchpad.37signals.com/authorization/token?' + q, { method: 'POST', headers: { 'User-Agent': UA } });
  const j = await r.json().catch(() => ({}));
  if (!j.refresh_token) return page(res, `<h2>Basecamp didn't connect</h2><p>${String(j.error || r.status).replace(/[<>&]/g, '')}. Open this page again to retry.</p>`);
  return page(res, `<h2>Connected</h2><p>Copy this into Vercel as <b>BC_REFRESH_TOKEN</b>, then redeploy. Don't share it.</p>
    <textarea readonly style="width:100%;height:120px;font:13px monospace" onclick="this.select()">${String(j.refresh_token).replace(/[<>&]/g, '')}</textarea>`);
};
