/* Shared helpers for the Abundance email feature.
   Files starting with "_" inside /api are NOT web addresses on Vercel —
   this file is only used by the other functions.

   All secrets live in Vercel → Settings → Environment Variables.
   Never put them in this repository (it is public). */

const crypto = require('crypto');

const DC = (process.env.ZOHO_DC || 'in').trim();          // India data centre by default
const URLS = {
  accounts: `https://accounts.zoho.${DC}`,
  mail:     `https://mail.zoho.${DC}`,
  crm:      `https://www.zohoapis.${DC}`,
};

/* Access tokens last about an hour; keep one while this function instance is warm. */
let cached = { token: null, exp: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const need = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN'].filter(k => !process.env[k]);
  if (need.length) throw new Error(`Setup incomplete: add ${need.join(', ')} in Vercel and redeploy.`);
  const body = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const r = await fetch(`${URLS.accounts}/oauth/v2/token`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Zoho sign-in failed (${j.error || r.status}). The refresh token may have been revoked.`);
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}

/* The tool sends the passcode in the "x-abundance-key" header. */
function passcodeOk(req) {
  const want = process.env.TOOL_PASSCODE || '';
  const got = String(req.headers['x-abundance-key'] || '');
  if (!want || !got) return false;
  const a = crypto.createHash('sha256').update(want).digest();
  const b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

function reply(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/* Reads a JSON body whether or not Vercel has already parsed it. */
async function jsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
/* "a@x.com, b@y.com; c@z.com" → ['a@x.com','b@y.com','c@z.com'] — throws on anything invalid */
function emailList(v, label) {
  const list = String(v || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  const bad = list.filter(e => !EMAIL_RE.test(e));
  if (bad.length) throw new Error(`${label}: "${bad[0]}" is not a valid email address.`);
  return list;
}

module.exports = { URLS, accessToken, passcodeOk, reply, jsonBody, emailList };
