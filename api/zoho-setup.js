/* /api/zoho-setup — one-time setup and health check page for the email feature.
   GET  → shows the setup page
   POST → { action:'exchange', code } turns a Zoho grant code into a refresh token
          { action:'test' }           checks every piece is connected
   Both POST actions need the passcode (TOOL_PASSCODE). */

const { env, DC, urlsFor, URLS, accessToken, passcodeOk, reply, jsonBody } = require('./_zoho');

async function mailAccounts(token, urls) {
  const r = await fetch(`${(urls || URLS).mail}/api/accounts`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mail account lookup failed (${(j.data && j.data.errorCode) || r.status}). Check the ZohoMail.accounts.READ scope.`);
  return (j.data || []).map(a => ({
    accountId: String(a.accountId),
    primary: a.primaryEmailAddress || a.mailboxAddress || '',
    sendFrom: (a.sendMailDetails || []).map(s => s.fromAddress).filter(Boolean),
  }));
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(PAGE);
  }
  if (req.method !== 'POST') return reply(res, 405, { error: 'Use GET or POST.' });
  if (!env('TOOL_PASSCODE')) return reply(res, 500, { error: 'Add TOOL_PASSCODE in Vercel and redeploy first.' });
  if (!passcodeOk(req)) return reply(res, 401, { error: 'Passcode did not match.' });

  try {
    const b = await jsonBody(req);

    if (b.action === 'exchange') {
      if (!env('ZOHO_CLIENT_ID') || !env('ZOHO_CLIENT_SECRET'))
        return reply(res, 500, { error: 'ZOHO_CLIENT_ID or ZOHO_CLIENT_SECRET is missing in Vercel. Add both, redeploy, then try again.' });
      const code = String(b.code || '').trim();
      if (!code) return reply(res, 400, { error: 'Paste the grant code.' });
      /* Try the configured Zoho region first, then the others: a key made on
         zoho.com is refused by zoho.in as "invalid_client". */
      const regions = [DC, ...['in', 'com', 'eu', 'com.au', 'jp', 'ca', 'sa'].filter(d => d !== DC)];
      let j = {}, used = null;
      for (const dc of regions) {
        const body = new URLSearchParams({
          grant_type: 'authorization_code', code,
          client_id: env('ZOHO_CLIENT_ID'), client_secret: env('ZOHO_CLIENT_SECRET'),
        });
        const r = await fetch(`${urlsFor(dc).accounts}/oauth/v2/token`, { method: 'POST', body });
        j = await r.json().catch(() => ({}));
        if (j.refresh_token) { used = dc; break; }
        if (j.error && j.error !== 'invalid_client') break;      // right region, other problem
      }
      if (!used) {
        const why = j.error === 'invalid_client'
          ? 'Zoho does not recognise the Client ID and Client Secret saved in Vercel. Re-copy both from the same Self Client (Client Secret tab), save them again in Vercel, redeploy, then generate a fresh code.'
          : j.error === 'invalid_code'
            ? 'The grant code has expired or was already used. Generate a new one and paste it straight away.'
            : `Zoho refused the code (${j.error || 'no reply'}).`;
        return reply(res, 400, { error: why });
      }
      const accounts = await mailAccounts(j.access_token, urlsFor(used)).catch(e => ({ error: e.message }));
      return reply(res, 200, { refreshToken: j.refresh_token, scope: j.scope || '', accounts,
        region: used, regionNote: used === DC ? '' : `Your Zoho account is on zoho.${used}. Also add ZOHO_DC = ${used} in Vercel.` });
    }

    if (b.action === 'test') {
      const checks = [];
      const token = await accessToken();
      checks.push(['Zoho sign-in', true, 'Refresh token works']);
      const accs = await mailAccounts(token).catch(e => e);
      if (accs instanceof Error) checks.push(['Zoho Mail', false, accs.message]);
      else {
        const acc = accs.find(a => a.accountId === env('ZOHO_MAIL_ACCOUNT_ID'));
        checks.push(['Mail account ID', !!acc, acc ? `Matches ${acc.primary}` : 'ZOHO_MAIL_ACCOUNT_ID is missing or does not match. IDs found: ' + accs.map(a => `${a.accountId} (${a.primary})`).join(', ')]);
        const from = env('FROM_ADDRESS').toLowerCase();
        const allowed = acc ? [acc.primary, ...acc.sendFrom].map(s => s.toLowerCase()) : [];
        checks.push(['From address', !!acc && allowed.includes(from), from ? (allowed.includes(from) ? `${from} can send` : `${from} is not an address of this account. Allowed: ${allowed.join(', ')}`) : 'FROM_ADDRESS is missing']);
      }
      const cr = await fetch(`${URLS.crm}/crm/v8/Contacts/search?word=zzqx&per_page=1`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      checks.push(['Zoho CRM', cr.ok || cr.status === 204, cr.ok || cr.status === 204 ? 'Contacts can be looked up' : `CRM refused (${cr.status}). Check the ZohoCRM.modules.contacts.READ scope.`]);
      return reply(res, 200, { checks });
    }

    return reply(res, 400, { error: 'Unknown action.' });
  } catch (e) {
    return reply(res, 502, { error: e.message || 'Something went wrong.' });
  }
};

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Email Setup · Abundance</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;background:#F0F8FF;font-family:Calibri,'Segoe UI',sans-serif;color:#1d2521;font-size:16px;line-height:1.5}
header{background:#005826;color:#fff;padding:16px 20px}header h1{font:700 17px Montserrat,sans-serif;margin:0}header p{margin:2px 0 0;font-size:13px;opacity:.8}
main{max-width:640px;margin:0 auto;padding:16px}
.card{background:#fff;border:1px solid #e2e8e4;border-radius:14px;padding:16px;margin-bottom:14px}
h2{font:700 13px Montserrat,sans-serif;letter-spacing:.5px;color:#005826;margin:0 0 8px}
label{display:block;font-size:13px;font-weight:600;color:#5c6a63;margin:10px 0 4px}
input,textarea{width:100%;font:inherit;background:#f4f7f5;border:1.5px solid transparent;border-radius:10px;padding:11px}
input:focus,textarea:focus{outline:none;border-color:#005826;background:#fff}
button{margin-top:12px;border:0;border-radius:10px;padding:11px 16px;background:#005826;color:#fff;font:700 13.5px Montserrat,sans-serif;cursor:pointer}
button:disabled{opacity:.5}
.out{margin-top:12px;font-size:14px}.out code{display:block;word-break:break-all;background:#fff6e0;border:1px solid #F9B738;border-radius:8px;padding:9px;margin:4px 0 8px;font-size:13px}
.ok{color:#005826}.bad{color:#934E32}small{color:#93a099;font-size:12.5px}
</style></head><body>
<header><h1>Email to client · Setup</h1><p>One-time connection between the Portfolio Generator and your Zoho account</p></header>
<main>
<div class="card"><h2>PASSCODE</h2>
<label for="k">The TOOL_PASSCODE you set in Vercel</label><input id="k" type="password" autocomplete="off"></div>

<div class="card"><h2>STEP A · GET THE REFRESH TOKEN</h2>
<small>Paste the grant code from api-console.zoho.in (Self Client → Generate Code). It expires in a few minutes.</small>
<label for="c">Grant code</label><input id="c" autocomplete="off">
<button id="go">Get refresh token</button><div class="out" id="o1"></div></div>

<div class="card"><h2>STEP B · CHECK EVERYTHING WORKS</h2>
<small>Run this after adding all the values in Vercel and redeploying.</small><br>
<button id="t">Test connection</button><div class="out" id="o2"></div></div>
</main>
<script>
const $=s=>document.querySelector(s),esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function call(body){const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json','x-abundance-key':$('#k').value},body:JSON.stringify(body)});const j=await r.json().catch(()=>({error:'No response'}));if(!r.ok)throw new Error(j.error||r.status);return j;}
$('#go').onclick=async()=>{const o=$('#o1');o.textContent='Working…';$('#go').disabled=true;
 try{const j=await call({action:'exchange',code:$('#c').value});
  let h='<p class="ok"><b>Done.</b> Copy these into Vercel → Settings → Environment Variables. This token is shown only once; do not paste it anywhere else.</p>';
  if(j.regionNote)h+='<p class="bad"><b>'+esc(j.regionNote)+'</b></p>';
  h+='<b>ZOHO_REFRESH_TOKEN</b><code>'+esc(j.refreshToken)+'</code>';
  if(Array.isArray(j.accounts))j.accounts.forEach(a=>{h+='<b>ZOHO_MAIL_ACCOUNT_ID</b> (for '+esc(a.primary)+')<code>'+esc(a.accountId)+'</code><small>FROM_ADDRESS can be: '+esc([a.primary].concat(a.sendFrom).filter((v,i,s)=>v&&s.indexOf(v)===i).join(', '))+'</small><br>';});
  else if(j.accounts&&j.accounts.error)h+='<p class="bad">'+esc(j.accounts.error)+'</p>';
  h+='<p><small>Scopes granted: '+esc(j.scope)+'</small></p>';o.innerHTML=h;
 }catch(e){o.innerHTML='<p class="bad">'+esc(e.message)+'</p>';}finally{$('#go').disabled=false;}};
$('#t').onclick=async()=>{const o=$('#o2');o.textContent='Checking…';
 try{const j=await call({action:'test'});o.innerHTML=j.checks.map(c=>'<p class="'+(c[1]?'ok':'bad')+'">'+(c[1]?'✔ ':'✘ ')+'<b>'+esc(c[0])+'</b> — '+esc(c[2])+'</p>').join('');}
 catch(e){o.innerHTML='<p class="bad">'+esc(e.message)+'</p>';}};
</script></body></html>`;
