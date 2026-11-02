/* GET /api/crm-contact?name=Venkatesh Kumar S
   Looks the client up in Zoho CRM Contacts (read-only) and returns only what the
   email panel needs: name, email, masked PAN (to tell two clients apart) and the
   greeting, if a "Greeting" field is ever added in CRM. Nothing else leaves Zoho. */

const { URLS, accessToken, passcodeOk, reply } = require('./_zoho');

const FIELDS = 'Full_Name,Last_Name,Email,PAN_No,Minor,Greeting';

async function search(token, word) {
  const base = `${URLS.crm}/crm/v8/Contacts/search?word=${encodeURIComponent(word)}&per_page=20`;
  const headers = { Authorization: `Zoho-oauthtoken ${token}` };
  let r = await fetch(`${base}&fields=${FIELDS}`, { headers });
  if (r.status === 400) r = await fetch(base, { headers });   // older API versions reject "fields"
  if (r.status === 204) return [];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`CRM search failed (${(j && (j.code || j.message)) || r.status}).`);
  return Array.isArray(j.data) ? j.data : [];
}

const maskPan = p => {
  p = String(p || '').trim().toUpperCase();
  return p.length >= 5 ? '•••••' + p.slice(-5) : '';
};
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

module.exports = async (req, res) => {
  if (req.method !== 'GET') return reply(res, 405, { error: 'Use GET.' });
  if (!passcodeOk(req)) return reply(res, 401, { error: 'Passcode did not match.' });

  const name = String((req.query && req.query.name) || '').trim().slice(0, 80);
  if (name.replace(/\W/g, '').length < 2) return reply(res, 400, { error: 'Type the client name first.' });

  try {
    const token = await accessToken();
    let rows = await search(token, name);
    if (!rows.length) {                       // full name found nothing — try its longest word
      const longest = name.split(/\s+/).sort((a, b) => b.length - a.length)[0];
      if (longest && longest.length >= 3 && longest !== name) rows = await search(token, longest);
    }
    const want = norm(name);
    const out = rows.map(c => {
      const nm = c.Full_Name || c.Last_Name || '';
      return {
        id: String(c.id || ''),
        name: nm,
        email: c.Email || '',
        pan: maskPan(c.PAN_No),
        minor: !!c.Minor,
        greeting: typeof c.Greeting === 'string' ? c.Greeting : '',
        exact: norm(nm) === want,
      };
    })
      .sort((a, b) => (b.exact - a.exact) || (!!b.email - !!a.email) || a.name.localeCompare(b.name))
      .slice(0, 10);
    return reply(res, 200, { contacts: out });
  } catch (e) {
    return reply(res, 502, { error: e.message || 'Could not reach Zoho CRM.' });
  }
};
