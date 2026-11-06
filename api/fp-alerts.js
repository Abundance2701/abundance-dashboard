/* /api/fp-alerts — "Create Alerts in CRM" from the Financial Planning Tool (annual reviews only).
   GET  ?pan=ABCDE1234F[,PQRST5678K]  → the matching Zoho CRM contacts with their current Goal Alerts (read only)
   POST { id, before, after }          → writes the new Goal Alerts to that contact

   Safety rules, checked here on the server (not only in the page):
   - passcode (TOOL_PASSCODE) required;
   - "before" must still match what is in CRM (someone may have edited it since the preview) → else 409;
   - only lines starting with [FP …] (plus their "or …" lines) may change: every other line must come back
     exactly as it was, in the same order → else 400. Manual profit-booking rules can never be touched;
   - every line must be readable by the checker (api/pb-check.js) and the field must stay within 2000 characters.
   Writing needs the Zoho scope ZohoCRM.modules.contacts.UPDATE (see /api/zoho-setup). */

const Z = require('./_zoho');
const { parseRule } = require('./pb-check');

const MAX = 32000;
const lines = t => String(t || '').replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
/* blocks: a line plus the "or …" lines under it; [FP …] blocks are the planning tool's */
/* blocks: a line plus the lines that belong to it ("or …" lines; a GOAL ALERT's Part / In debt by / How lines).
   [FP …] and GOAL ALERT blocks belong to the planning tool; everything else is the user's own. */
const isPart = l => /^(part\s+\d+\s+of\s+\d+|in debt by|how)\s*:/i.test(l);
const blocks = t => { const out = []; for (const l of lines(t)) { const prev = out[out.length - 1]; if (prev && (/^or\s/i.test(l) || (isPart(l) && /^goal alert:/i.test(prev[0])))) prev.push(l); else out.push([l]); } return out; };
const isFP = b => /^(\[fp\b|goal alert:)/i.test(b[0]);
const manual = t => blocks(t).filter(b => !isFP(b)).map(b => b.join('\n')).join('\n');
const norm = t => lines(t).join('\n');
const maskPan = p => { p = String(p || '').trim().toUpperCase(); return p.length >= 5 ? '•••••' + p.slice(-5) : ''; };

async function crm(path, init) {
  const tok = await Z.accessToken();
  const r = await fetch(`${Z.urls().crm}/crm/v8/${path}`, { ...init, headers: { Authorization: `Zoho-oauthtoken ${tok}`, 'Content-Type': 'application/json', ...(init && init.headers) } });
  if (r.status === 204) return { data: [] };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = String((j && (j.code || (j.data && j.data[0] && j.data[0].code))) || r.status);
    if (/SCOPE|OAUTH|401|NO_PERMISSION/i.test(code)) throw Object.assign(new Error('The Zoho key in Vercel can read Contacts but not update them. One-time fix: on /api/zoho-setup, make a new grant code that also includes ZohoCRM.modules.contacts.UPDATE, then put the new refresh token in Vercel (ZOHO_REFRESH_TOKEN) and redeploy.'), { status: 403 });
    throw Object.assign(new Error(`Zoho CRM said ${code}.`), { status: 502 });
  }
  return j;
}

module.exports = async (req, res) => {
  /* the downloaded copy of the tool (opened from the computer) calls this from another origin; the passcode still protects it */
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'x-abundance-key, content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (!Z.passcodeOk(req)) return Z.reply(res, 401, { error: 'Passcode did not match.' });
  try {
    if (req.method === 'GET') {
      const pans = String((req.query && req.query.pan) || '').toUpperCase().split(',').map(s => s.trim()).filter(p => /^[A-Z]{5}\d{4}[A-Z]$/.test(p)).slice(0, 4);
      if (!pans.length) return Z.reply(res, 400, { error: 'No valid PAN in the client data (About You sheet).' });
      const found = [];
      for (const pan of pans) {
        const j = await crm(`Contacts/search?criteria=${encodeURIComponent(`(PAN_No:equals:${pan})`)}&fields=Full_Name,PAN_No,Goal_Alerts&per_page=10`);
        (j.data || []).forEach(c => found.push({ id: c.id, name: c.Full_Name || '', pan: maskPan(c.PAN_No), forPan: maskPan(pan), rule: c.Goal_Alerts || '' }));
      }
      return Z.reply(res, 200, { contacts: found });
    }
    if (req.method === 'POST') {
      const b = await Z.jsonBody(req), id = String(b.id || '');
      if (!/^\d{6,25}$/.test(id)) return Z.reply(res, 400, { error: 'Pick the CRM contact first.' });
      const cur = ((await crm(`Contacts/${id}?fields=Full_Name,Goal_Alerts`)).data || [])[0];
      if (!cur) return Z.reply(res, 404, { error: 'That contact is no longer in CRM.' });
      if (norm(cur.Goal_Alerts) !== norm(b.before)) return Z.reply(res, 409, { error: 'The Goal Alerts in CRM changed after you opened this preview. Close and open "Create Alerts in CRM" again.', rule: cur.Goal_Alerts || '' });
      const after = norm(b.after);
      if (manual(after) !== manual(cur.Goal_Alerts)) return Z.reply(res, 400, { error: 'Only goal alerts may be changed from the planning tool. Your other Goal Alerts lines must stay as they are.' });
      const bad = parseRule(after).bad;
      if (bad.length) return Z.reply(res, 400, { error: `This line can't be read by the alert checker: "${bad[0]}"` });
      if (after.length > MAX) return Z.reply(res, 400, { error: `Goal Alerts would be ${after.length} characters; Zoho allows ${MAX}.` });
      if (after === norm(cur.Goal_Alerts)) return Z.reply(res, 200, { ok: true, unchanged: true, rule: after });
      const w = await crm('Contacts', { method: 'PUT', body: JSON.stringify({ data: [{ id, Goal_Alerts: after || null }] }) });
      const st = w.data && w.data[0];
      if (!st || st.code !== 'SUCCESS') throw Object.assign(new Error('Zoho CRM did not save it' + (st && st.message ? ': ' + st.message : '.')), { status: 502 });
      return Z.reply(res, 200, { ok: true, rule: after, name: cur.Full_Name || '' });
    }
    return Z.reply(res, 405, { error: 'Use GET or POST.' });
  } catch (e) { return Z.reply(res, e.status || 500, { error: e.message }); }
};
module.exports.blocks = blocks;
module.exports.manual = manual;
