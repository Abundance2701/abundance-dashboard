/* Basecamp helpers for the profit-booking alerts. Not a web address (file starts with "_").
   Secrets live in Vercel → Settings → Environment Variables (this repository is public):
     BC_CLIENT_ID, BC_CLIENT_SECRET   from launchpad.37signals.com/integrations
     BC_REFRESH_TOKEN                 shown once by /api/bc-auth after you approve access */

const env = k => String(process.env[k] || '').trim();
const ACCOUNT = '5713492', PROJECT = '46433360';
const LIST = '10478724917';                 // Investments → Tasks → "Profit booking clients"
const NOTES_BOARD = '10394621098';          // Investments → "✏ Notes" (holds the rules message)
const HARITHA = 45008338;
const UA = 'Abundance Market Pulse (abundance.co.in)';
const API = `https://3.basecampapi.com/${ACCOUNT}`;
const redirectUri = () => (env('BC_REDIRECT_URI') || 'https://abundance-dashboard-beta.vercel.app/api/bc-auth');

let cached = { token: null, exp: 0 };
async function token() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const need = ['BC_CLIENT_ID', 'BC_CLIENT_SECRET', 'BC_REFRESH_TOKEN'].filter(k => !env(k));
  if (need.length) throw new Error('Basecamp not set up: add ' + need.join(', ') + ' in Vercel.');
  const q = new URLSearchParams({ type: 'refresh', refresh_token: env('BC_REFRESH_TOKEN'), client_id: env('BC_CLIENT_ID'), client_secret: env('BC_CLIENT_SECRET'), redirect_uri: redirectUri() });
  const r = await fetch('https://launchpad.37signals.com/authorization/token?' + q, { method: 'POST', headers: { 'User-Agent': UA } });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Basecamp sign-in failed (' + (j.error || r.status) + ').');
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}
async function bc(path, opts = {}) {
  const t = await token();
  const r = await fetch(path.startsWith('http') ? path : API + path, { ...opts, headers: { Authorization: 'Bearer ' + t, 'User-Agent': UA, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error('Basecamp ' + r.status + ' on ' + path.replace(API, ''));
  const next = ((r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null;
  return { data: r.status === 204 ? null : await r.json(), next };
}
async function all(path) {
  const out = []; let url = path;
  for (let i = 0; url && i < 20; i++) { const { data, next } = await bc(url); out.push(...(data || [])); url = next; }
  return out;
}
/* every to-do in the alert list, open and completed */
const alertTodos = async () => [...await all(`/buckets/${PROJECT}/todolists/${LIST}/todos.json`), ...await all(`/buckets/${PROJECT}/todolists/${LIST}/todos.json?completed=true`)];
const createTodo = (content, description, due_on) => bc(`/buckets/${PROJECT}/todolists/${LIST}/todos.json`, {
  method: 'POST', body: JSON.stringify({ content, description, due_on, assignee_ids: [HARITHA], notify: true }) }).then(x => x.data);
/* the rules live in a message on the Notes board titled "Profit booking alert rules", inside a code block */
async function rules() {
  const msgs = await all(`/buckets/${PROJECT}/message_boards/${NOTES_BOARD}/messages.json`);
  const m = msgs.find(x => /profit booking alert rules/i.test(x.subject || x.title || ''));
  if (!m) throw new Error('Rules message not found on the Notes board.');
  const html = String(m.content || '');
  const raw = (html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || [])[1] || html;
  const txt = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const s = txt.indexOf('['), e = txt.lastIndexOf(']');
  return JSON.parse(txt.slice(s, e + 1));
}
module.exports = { env, UA, redirectUri, token, bc, alertTodos, createTodo, rules, ACCOUNT, PROJECT, LIST };
