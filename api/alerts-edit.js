/* /api/alerts-edit — the Alert Editor page (Alert_Editor.html). Passcode (TOOL_PASSCODE) on every call.
   GET  ?q=<name>        → up to 15 Zoho CRM contacts whose name contains it {id, name, has}
   GET  ?id=<contact id> → that contact's Goal Alerts split into blocks, each parsed by the alert checker
                           (api/pb-check.js parseRule), with its alert history and a plain-English status,
                           plus the Goal Alert Plan note and today's index levels
   POST {id, before, beforePlan, rule, plan, preview}
        preview:true → checks only: unreadable lines, size, and which earlier alerts the edit would let fire again
        otherwise    → writes Goal_Alerts and PB_Plan (label "Goal Alert Plan") to CRM
   Safety: "before"/"beforePlan" must still match CRM (else 409); every line must be readable by the checker. */

const Z = require('./_zoho');
const B = require('./_bc');
const PB = require('./pb-check');
const { blocks } = require('./fp-alerts');
const { parseRule, hash } = PB, D = PB.data;

const MAX = 32000;
const norm = t => String(t || '').replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean).join('\n');
const dmy = d => d ? d.split('-').reverse().join('/') : '';
const fmt = v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

async function crm(path, init) {
  const tok = await Z.accessToken();
  const r = await fetch(`${Z.urls().crm}/crm/v8/${path}`, { ...init, headers: { Authorization: `Zoho-oauthtoken ${tok}`, 'Content-Type': 'application/json', ...(init && init.headers) } });
  if (r.status === 204) return { data: [] };
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('Zoho CRM said ' + ((j && (j.code || (j.data && j.data[0] && j.data[0].code))) || r.status) + '.'), { status: 502 });
  return j;
}

/* the memory keys a parsed alert line uses (same as api/pb-check.js) */
const prefixOf = (cid, R) => R.type === 'gblock' ? `${cid}/g${hash(R.name)}` : `${cid}/${R.id}`;

/* every alert already sent for this contact: key → [dates] */
async function history(cid) {
  const keys = {};
  const add = t => { for (const m of String(t || '').matchAll(/pb-key:\s*([\w\-]+\/[\w\-]+)\/(\d{4}-\d{2}-\d{2})/g)) if (m[1].startsWith(cid + '/')) { const a = (keys[m[1]] = keys[m[1]] || []); if (!a.includes(m[2])) a.push(m[2]); } };
  const [todos, memo] = await Promise.all([B.alertTodos().catch(() => []), B.memoryDoc().catch(() => null)]);
  todos.forEach(t => add(t.description)); if (memo) add(memo.content);
  return keys;
}

/* Plain-English status of one parsed line, for the editor card. L = live levels, H = closes (oldest first, before today). */
function status(cid, R, keys, L, H, T) {
  const P = prefixOf(cid, R), sent = Object.entries(keys).filter(([k]) => k === P || k.startsWith(P + '-')).flatMap(([k, ds]) => ds.map(d => ({ k: k.slice(P.length), d }))).sort((a, b) => a.d < b.d ? -1 : 1);
  const lab = k => D.LABEL[k], now = k => L[k];
  const closes = (k, a) => (H[k] || []).filter(r => r[0] >= a).map(r => r[1]);
  const away = (k, lvl, down) => { const n = now(k); if (!n) return ''; const g = down ? 1 - lvl / n : lvl / n - 1;
    return g <= 0 ? ` · now ${fmt(n)}: already there, alerts at the next 2:45 PM / 3:45 PM check if it holds` : ` · now ${fmt(n)} (${(g * 100).toFixed(1)}% to go)`; };
  const out = [];
  if (R.from && T < R.from) out.push(`Starts ${dmy(R.from)}`);
  if (R.until && T > R.until) out.push(`Ended ${dmy(R.until)}`);
  if (R.type === 'at') {
    const n = Math.max(...R.alts.map(a => a.levels.length));
    for (let i = 0; i < n; i++) {
      const s = sent.find(x => x.k === `-p${i + 1}`);
      if (s) out.push(`Part ${i + 1}: alerted ${dmy(s.d)}`);
      else { const a = R.alts.filter(a => a.levels[i]).map(a => ({ a, gap: now(a.idx) ? a.levels[i] / now(a.idx) : 9 })).sort((x, y) => x.gap - y.gap)[0];
        out.push(`Part ${i + 1}: waiting for ${lab(a.a.idx)} at ${fmt(a.a.levels[i])}${away(a.a.idx, a.a.levels[i])}`); }
    }
  } else if (R.type === 'move') {
    const s = sent[0]; if (s) out.push(`Alerted ${dmy(s.d)}`);
    else R.alts.forEach(a => { const b = (H[a.idx] || []).find(r => r[0] >= R.from); if (!b) { out.push(`${lab(a.idx)}: waiting for the ${dmy(R.from)} close`); return; }
      const lvl = b[1] * (1 + (a.dir === 'up' ? 1 : -1) * a.pct / 100); out.push(`${lab(a.idx)}: needs ${a.dir === 'up' ? '≥' : '≤'} ${fmt(lvl)} (${a.dir} ${a.pct}% from ${fmt(b[1])} on ${dmy(b[0])})${away(a.idx, lvl, a.dir === 'down')}`); });
  } else if (R.type === 'w52' || R.type === 'newHigh') {
    const s = sent[0]; if (s && !R.repeat) out.push(`Alerted ${dmy(s.d)}`);
    else (R.alts || [{ idx: R.idx }]).forEach(a => { const cs = R.type === 'w52' ? closes(a.idx, D.addDays(T, -364)) : closes(a.idx, R.from); if (!cs.length) return; const hi = Math.max(...cs); out.push(`${lab(a.idx)}: needs a close above ${fmt(hi)}${away(a.idx, hi)}`); });
  } else if (['fall', 'rise', 'aboveHigh'].includes(R.type)) {
    sent.forEach(s => out.push(`Alerted ${dmy(s.d)}`));
    if (!sent.length || R.repeat) { const lf = sent.length ? sent[sent.length - 1].d : null, since = (R.repeat && lf) || R.from;
      (R.alts || [{ idx: R.idx, pct: R.pct }]).forEach(A => { const cs = closes(A.idx, since), pct = A.pct != null ? A.pct : R.pct; if (!cs.length) return;
        if (R.type === 'fall') { const hi = Math.max(...cs, now(A.idx) || 0), lvl = hi * (1 - pct / 100); out.push(`${lab(A.idx)}: needs ≤ ${fmt(lvl)} (${pct}% below its high of ${fmt(hi)} since ${dmy(since)})${away(A.idx, lvl, true)}`); }
        if (R.type === 'rise') { const lo = Math.min(...cs), lvl = lo * (1 + pct / 100); out.push(`${lab(A.idx)}: needs ≥ ${fmt(lvl)} (${pct}% above its low of ${fmt(lo)} since ${dmy(since)})${away(A.idx, lvl)}`); }
        if (R.type === 'aboveHigh') { const cs2 = (H[A.idx] || []).filter(r => r[0] >= D.addDays(R.from, -30) && r[0] <= (lf || D.addDays(R.from, -1))).map(r => r[1]); if (!cs2.length) return; const hi = Math.max(...cs2), lvl = hi * (1 + pct / 100); out.push(`${lab(A.idx)}: needs ≥ ${fmt(lvl)} (${pct}% above its earlier high of ${fmt(hi)})${away(A.idx, lvl)}`); } }); }
  } else if (R.type === 'remind') {
    R.dates.forEach(d => { const s = sent.find(x => x.k === '-' + d); out.push(s ? `${dmy(d)}: sent ${dmy(s.d)}` : T > D.addDays(d, 10) ? `${dmy(d)}: passed` : `${dmy(d)}: coming up${R.unless ? ` (skipped if "${R.unless}" alerts first)` : ''}`); });
  } else if (R.type === 'gblock') {
    R.parts.forEach(p => { const pk = `-${hash(p.from + p.to)}`, hit = sent.find(x => x.k === pk + '-w52'), end = sent.find(x => x.k === pk + '-end');
      let st = hit ? `alerted ${dmy(hit.d)}` : end ? `ended without a trigger, reminder sent ${dmy(end.d)}` : T < p.from ? 'not started' : T > p.to ? 'ended' : 'watching';
      if (!hit && T >= p.from && T <= p.to) { const best = ['nifty 50', 'midcap 150', 'smallcap 250'].map(k => { const cs = R.trig === 'new' ? closes(k, p.from) : closes(k, D.addDays(T, -364)); if (!cs.length || !now(k)) return null; const hi = Math.max(...cs); return { k, hi, gap: hi / now(k) }; }).filter(Boolean).sort((a, b) => a.gap - b.gap)[0];
        if (best) st += `: needs ${lab(best.k)} above ${fmt(best.hi)}${away(best.k, best.hi)}`; else if (R.trig === 'new') st += ' (from the day after it starts)'; }
      out.push(`Part ${p.no} of ${p.of} (${dmy(p.from)}–${dmy(p.to)}): ${st}`); });
    if (R.by) { const bs = sent.filter(x => x.k.startsWith(`-by${hash(R.by)}`)); out.push(`In debt by ${dmy(R.by)}: ${bs.length ? 'reminders sent ' + bs.map(x => dmy(x.d)).join(', ') : 'reminders 7 days before and on the day'}`); }
  } else if (R.type === 'goal') sent.forEach(s => out.push(`Alerted ${dmy(s.d)}`));
  return { lines: out, sent: sent.map(s => s.d) };
}

/* Which earlier alerts would be allowed to fire again if the box became `after` */
function lost(cid, keys, after) {
  const { lines } = parseRule(after), still = new Set();
  lines.forEach(R => { const P = prefixOf(cid, R);
    Object.keys(keys).forEach(k => { if (k !== P && !k.startsWith(P + '-')) return;
      if (R.type !== 'gblock') { still.add(k); return; }
      const rest = k.slice(P.length);                                 // -<parthash>-w52 | -<parthash>-end | -by<hash>-<date>
      if (R.parts.some(p => rest.startsWith(`-${hash(p.from + p.to)}-`)) || (R.by && rest.startsWith(`-by${hash(R.by)}`))) still.add(k); }); });
  return Object.keys(keys).filter(k => !k.startsWith(cid + '/bad-') && !still.has(k));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!Z.passcodeOk(req)) return Z.reply(res, 401, { error: 'Passcode did not match.' });
  try {
    if (req.method === 'GET' && req.query && req.query.q != null) {
      const q = String(req.query.q).replace(/[^\p{L}\p{N} .&-]/gu, '').trim().slice(0, 40);
      if (q.length < 2) return Z.reply(res, 200, { contacts: [] });
      const j = await crm('coql', { method: 'POST', body: JSON.stringify({ select_query: `select Full_Name, PB_Plan from Contacts where Full_Name like '%${q.replace(/'/g, '')}%' limit 15` }) });
      const ids = (j.data || []).map(c => ({ id: c.id, name: c.Full_Name || '' }));
      /* Goal Alerts is a large text field: COQL can't return it in a list, so ask for those few contacts directly */
      if (ids.length) { const k = await crm(`Contacts?ids=${ids.map(c => c.id).join(',')}&fields=Goal_Alerts`); const m = {}; (k.data || []).forEach(c => { m[c.id] = !!String(c.Goal_Alerts || '').trim(); }); ids.forEach(c => { c.has = !!m[c.id]; }); }
      return Z.reply(res, 200, { contacts: ids.sort((a, b) => (b.has - a.has) || a.name.localeCompare(b.name)) });
    }
    if (req.method === 'GET') {
      const id = String((req.query && req.query.id) || ''); if (!/^\d{6,25}$/.test(id)) return Z.reply(res, 400, { error: 'Pick a client first.' });
      const T = D.today();
      const [c, keys, L, H] = await Promise.all([
        crm(`Contacts/${id}?fields=Full_Name,Goal_Alerts,PB_Plan`).then(j => (j.data || [])[0]),
        history(id),
        D.mcpLive().catch(() => D.nse()).catch(() => ({})),
        (async () => { const H = {}, src = {}; await Promise.all(Object.keys(D.IDX).map(async k => { try { H[k] = (await D.closesFor(k, T, src)).filter(r => r[0] < T); } catch (e) {} })); return H; })(),
      ]);
      if (!c) return Z.reply(res, 404, { error: 'That contact is no longer in CRM.' });
      const rule = String(c.Goal_Alerts || ''), out = blocks(rule).map(b => {
        const text = b.join('\n'), p = parseRule(text);
        if (p.bad.length || p.lines.length !== 1) return { text, bad: p.bad.length ? p.bad : ['Could not be read as one alert'] };
        const R = p.lines[0], st = status(id, R, keys, L, H, T);
        const { id: _i, src: _s, ...rest } = R;
        return { text, R: rest, status: st.lines, sent: st.sent };
      });
      return Z.reply(res, 200, { id, name: c.Full_Name || '', rule, plan: c.PB_Plan || '', blocks: out, live: L, today: T });
    }
    if (req.method === 'POST') {
      const b = await Z.jsonBody(req), id = String(b.id || '');
      if (!/^\d{6,25}$/.test(id)) return Z.reply(res, 400, { error: 'Pick a client first.' });
      const cur = ((await crm(`Contacts/${id}?fields=Full_Name,Goal_Alerts,PB_Plan`)).data || [])[0];
      if (!cur) return Z.reply(res, 404, { error: 'That contact is no longer in CRM.' });
      if (norm(cur.Goal_Alerts) !== norm(b.before) || String(cur.PB_Plan || '').trim() !== String(b.beforePlan || '').trim())
        return Z.reply(res, 409, { error: 'This client\'s alerts were changed in CRM after you opened them. Reload the client and make your change again.' });
      const after = norm(b.rule), plan = String(b.plan || '').trim();
      const bad = parseRule(after).bad;
      if (bad.length) return Z.reply(res, 400, { error: `This line can't be read by the alert checker: "${bad[0]}"` });
      if (after.length > MAX) return Z.reply(res, 400, { error: `Goal Alerts would be ${after.length} characters; Zoho allows ${MAX}.` });
      if (plan.length > 2000) return Z.reply(res, 400, { error: 'The plan note is over 2,000 characters.' });
      const keys = await history(id), gone = lost(id, keys, after);
      if (b.preview) return Z.reply(res, 200, { ok: true, text: after, refire: gone.length, unchanged: after === norm(cur.Goal_Alerts) && plan === String(cur.PB_Plan || '').trim() });
      const w = await crm('Contacts', { method: 'PUT', body: JSON.stringify({ data: [{ id, Goal_Alerts: after || null, PB_Plan: plan || null }], trigger: [] }) });
      const st = w.data && w.data[0];
      if (!st || st.code !== 'SUCCESS') throw Object.assign(new Error('Zoho CRM did not save it' + (st && st.message ? ': ' + st.message : '.')), { status: 502 });
      return Z.reply(res, 200, { ok: true, saved: true });
    }
    return Z.reply(res, 405, { error: 'Use GET or POST.' });
  } catch (e) { return Z.reply(res, e.status || 500, { error: e.message }); }
};
module.exports.config = { maxDuration: 60 };
module.exports.status = status;
module.exports.lost = lost;
