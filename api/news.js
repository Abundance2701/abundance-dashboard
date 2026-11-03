/* GET /api/news            → live market & mutual-fund headlines from the last ~36 hours
   GET /api/news?debug=1    → same, plus per-feed status
   Pulls public RSS feeds server-side (browsers can't, because of CORS), keeps only
   market / MF / regulation stories, drops stock-tip noise, merges duplicates across
   publications, and tags each with a topic. Headlines and links are the publishers' own;
   nothing is rewritten. Cached at the edge for 2 minutes. No secrets used. */

const FEEDS = [
  ['Economic Times', 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms'],
  ['Economic Times', 'https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms'],
  ['Economic Times', 'https://economictimes.indiatimes.com/mf/rssfeeds/359241701.cms'],
  ['Moneycontrol', 'https://www.moneycontrol.com/rss/marketreports.xml'],
  ['Moneycontrol', 'https://www.moneycontrol.com/rss/mfnews.xml'],
  ['Moneycontrol', 'https://www.moneycontrol.com/rss/economy.xml'],
  ['Mint', 'https://www.livemint.com/rss/markets'],
  ['Mint', 'https://www.livemint.com/rss/money'],
  ['Business Standard', 'https://www.business-standard.com/rss/markets-106.rss'],
  ['Business Standard', 'https://www.business-standard.com/rss/markets/mutual-fund-10612.rss'],
  ['BusinessLine', 'https://www.thehindubusinessline.com/markets/feeder/default.rss'],
  ['BusinessLine', 'https://www.thehindubusinessline.com/portfolio/mutual-funds/feeder/default.rss'],
  ['SEBI', 'https://www.sebi.gov.in/sebirss.xml'],
  ['RBI', 'https://rbi.org.in/pressreleases_rss.xml'],
  ['Google News', 'https://news.google.com/rss/search?q=(sensex+OR+nifty)+when:1d&hl=en-IN&gl=IN&ceid=IN:en'],
  ['Google News', 'https://news.google.com/rss/search?q=(%22mutual+fund%22+OR+AMFI+OR+SEBI+OR+%22fund+manager%22)+when:1d&hl=en-IN&gl=IN&ceid=IN:en'],
];

// Google News re-lists many small sites; keep only established Indian/global business publications
const TRUSTED = /economic times|^mint$|livemint|business standard|moneycontrol|businessline|cnbc ?tv18|ndtv profit|reuters|financial express|business today|value research|cafe ?mutual|morningstar|zee business|etmutualfunds|bloomberg|the hindu|times of india|hindustan times|india today|outlook money|fortune india|the print|bseindia|nse india|sebi|rbi|amfi|pib/i;
const KEEP = /sensex|nifty|market|stock|share|equit|mutual fund|\bmfs?\b|\bamcs?\b|amfi|sebi|\brbi\b|repo|inflation|cpi|wpi|\bgdp\b|fii|fpi|\bdii\b|rupee|bond|yield|crude|brent|oil|gold|silver|fed\b|wall street|nasdaq|dow|s&p|ipo|listing|results|q[1-4]\b|profit|earnings|sip\b|nfo|fund manager|index|etf|rally|slump|selloff|sell-off|tariff|trade deal|gift nifty|budget|tax/i;
const DROP = /stocks? to buy|stocks? under ₹|stock under rs|shares? under ₹|sri lanka|pakistan|bangladesh|buy or sell|top picks|multibagger|penny stock|technical pick|target price|trading ideas|stock recommendations|stocks? to watch|hot stocks|brokerage (calls|picks)|should you buy|horoscope|lottery|cricket|bollywood|smartphone|recipe|live score|quiz|photos:|in pics|watch:|video:|podcast|appeal no|adjudication order|settlement order|order in the matter|recovery certificate|notice of demand|money market operations|auction|vrrr/i;
const TOPICS = [
  ['rules', /sebi|amfi|\brbi\b|repo rate|monetary policy|mpc\b|circular|regulat|consultation paper|framework|guidelines|\bkyc\b|nominat|income tax|cbdt|gst council/i],
  ['mf', /mutual fund|\bmfs?\b|\bamcs?\b|\bnfo\b|\bsip\b|fund manager|\bscheme\b|index fund|\betfs?\b|\bsif\b|folio|aum\b|flexi ?cap|small ?cap fund|mid ?cap fund/i],
  ['markets', /sensex|nifty|market (close|open|ends|update)|markets? (today|rally|fall|slump|crash|gain)|\bfii|\bfpi|\bdii|rupee|gift nifty|closing bell|opening bell|india vix|bank nifty/i],
  ['global', /\bfed\b|federal reserve|wall street|nasdaq|\bdow\b|s&p ?500|crude|brent|\boil\b|dollar|treasury|china|japan|nikkei|europe|tariff|trump|iran|opec|global markets/i],
  ['economy', /inflation|\bcpi\b|\bwpi\b|\bgdp\b|\biip\b|\bpmi\b|fiscal|economy|exports|imports|trade deficit/i],
  ['stocks', /\bq[1-4]\b|results|profit|earnings|\bipo\b|listing|shares? (of|jump|fall|surge|rise|drop)|stake|block deal|merger|acquisi/i],
];

const ent = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? ent(m[1]) : ''; };
const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9₹% ]+/g, ' ').split(' ').filter(w => w.length > 2 && !/^(the|and|for|with|from|after|amid|over|into|says|this|that|its|are|was|has|have|will)$/.test(w)));
const sim = (a, b) => { let i = 0; a.forEach(w => b.has(w) && i++); return i / Math.min(a.size, b.size || 1); };

async function feed([src, url]) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (AbundanceMarketPulse)', Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(7000), redirect: 'follow' });
    if (!r.ok) return { src, url, ok: false, status: r.status, items: [] };
    const xml = await r.text();
    const out = [];
    for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
      const x = m[0];
      let title = tag(x, 'title'), pub = src;
      const link = tag(x, 'link') || (x.match(/<guid[^>]*>([^<]+)</i) || [])[1] || '';
      const when = Date.parse(tag(x, 'pubDate') || tag(x, 'dc:date') || '') || null;
      if (src === 'Google News') { const s = tag(x, 'source'); if (s) { pub = s; title = title.replace(new RegExp('\\s+-\\s+' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), ''); } }
      if (src === 'Google News' && !TRUSTED.test(pub)) continue;
      if (title) out.push({ title, url: link.trim(), src: pub, t: when, via: src });
    }
    return { src, url, ok: true, status: r.status, ms: Date.now() - t0, items: out };
  } catch (e) { return { src, url, ok: false, status: String(e.name || e.message).slice(0, 40), items: [] }; }
}

module.exports = async (req, res) => {
  const results = await Promise.all(FEEDS.map(feed));
  const now = Date.now(), since = now - 36 * 3600e3;
  let all = results.flatMap(r => r.items).filter(i => i.t && i.t > since && i.t < now + 3600e3);
  all = all.filter(i => (i.via === 'SEBI' || i.via === 'RBI' || KEEP.test(i.title)) && !DROP.test(i.title));
  // Google News re-lists the same publishers; drop those that repeat a direct-feed story
  all.sort((a, b) => (a.via === 'Google News') - (b.via === 'Google News') || b.t - a.t);
  const kept = [];
  for (const i of all) {
    const w = words(i.title);
    const dup = kept.find(k => sim(w, k.w) >= 0.6);
    if (dup) { if (!dup.also.includes(i.src) && i.src !== dup.src) dup.also.push(i.src); if (i.t < dup.t) dup.first = i.t; continue; }
    const topic = (TOPICS.find(([, re]) => re.test(i.title)) || ['other'])[0];
    kept.push({ ...i, w, also: [], topic });
  }
  kept.sort((a, b) => b.t - a.t);
  const items = kept.slice(0, 250).map(({ w, via, first, ...i }) => ({ ...i, id: (i.url || i.title).slice(-120) }));
  const body = { updated: new Date(now).toISOString(), count: items.length, items };
  if (req.query && req.query.debug) body.feeds = results.map(r => ({ src: r.src, url: r.url, ok: r.ok, status: r.status, ms: r.ms, n: r.items.length }));
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(JSON.stringify(body));
};
