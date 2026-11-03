"""Daily market data for the Abundance dashboard's Market Pulse page.
Runs in GitHub Actions (free, no API key). Writes:
  data/indices.json  - level, day's move and 1W/1M/3M/6M/YTD/1Y returns for key Indian indices (Yahoo Finance daily closes)
  data/official.json - latest notices from official RSS feeds (SEBI, RBI, NSE), so nothing regulatory is missed
Each source is tried independently; a failure is recorded, never fatal."""
import json, datetime as dt, urllib.request, urllib.parse, xml.etree.ElementTree as ET, re, os, time

UA = {'User-Agent': 'Mozilla/5.0 (compatible; AbundanceDashboard/1.0)'}
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
os.makedirs('data', exist_ok=True)

def get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

# name, list of Yahoo symbols to try in order
INDICES = [
    ('Nifty 50', ['^NSEI']),
    ('Sensex', ['^BSESN']),
    ('Bank Nifty', ['^NSEBANK']),
    ('Nifty Midcap 150', ['NIFTYMIDCAP150.NS', '^NIFTYMIDCAP150', 'NIFTY_MIDCAP_100.NS']),
    ('Nifty Smallcap 250', ['NIFTYSMLCAP250.NS', '^NIFTYSMLCAP250', '^CNXSC']),
    ('Nifty IT', ['^CNXIT']),
    ('India VIX', ['^INDIAVIX']),
]

def closes(sym):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=2y&interval=1d'
    j = json.loads(get(url))
    res = j['chart']['result'][0]
    ts = res['timestamp']; cl = res['indicators']['quote'][0]['close']
    pts = [(dt.datetime.fromtimestamp(t, IST).date(), c) for t, c in zip(ts, cl) if c is not None]
    meta = res.get('meta', {})
    # live/last price for today if the daily bar is incomplete
    if meta.get('regularMarketPrice') and meta.get('regularMarketTime'):
        d = dt.datetime.fromtimestamp(meta['regularMarketTime'], IST).date()
        if pts and d >= pts[-1][0]:
            if d == pts[-1][0]: pts[-1] = (d, meta['regularMarketPrice'])
            else: pts.append((d, meta['regularMarketPrice']))
    return pts, meta.get('longName') or meta.get('shortName') or sym

def on_or_before(pts, d):
    best = None
    for p in pts:
        if p[0] <= d: best = p
        else: break
    return best

def perf(pts):
    last_d, last = pts[-1]; prev = pts[-2][1] if len(pts) > 1 else None
    def back(**kw):
        d = last_d - dt.timedelta(**kw) if kw else None
        return d
    def ret(d):
        p = on_or_before(pts, d)
        return round((last / p[1] - 1) * 100, 2) if p and p[1] else None
    ytd_base = on_or_before(pts, dt.date(last_d.year - 1, 12, 31))
    month = lambda m: (last_d.replace(day=1) - dt.timedelta(days=1)) if False else None
    def months_back(n):
        y, m = last_d.year, last_d.month - n
        while m <= 0: m += 12; y -= 1
        import calendar
        return dt.date(y, m, min(last_d.day, calendar.monthrange(y, m)[1]))
    return {
        'date': last_d.isoformat(), 'level': round(last, 2),
        'chg': round(last - prev, 2) if prev else None, 'chgPct': round((last / prev - 1) * 100, 2) if prev else None,
        'perf': {'1W': ret(last_d - dt.timedelta(days=7)), '1M': ret(months_back(1)), '3M': ret(months_back(3)),
                 '6M': ret(months_back(6)), 'YTD': round((last / ytd_base[1] - 1) * 100, 2) if ytd_base else None,
                 '1Y': ret(months_back(12))},
        'spark': [round(c, 2) for _, c in pts[-22:]],
    }

out = {'updated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': 'Yahoo Finance daily closes', 'indices': [], 'errors': []}
for name, syms in INDICES:
    for s in syms:
        try:
            pts, _ = closes(s)
            if len(pts) < 30: raise ValueError('too few points')
            out['indices'].append({'name': name, 'symbol': s, **perf(pts)}); break
        except Exception as e:
            out['errors'].append(f'{name} {s}: {str(e)[:80]}'); time.sleep(1)
json.dump(out, open('data/indices.json', 'w'), ensure_ascii=False, indent=1)
print('indices:', [i['name'] for i in out['indices']], 'errors:', out['errors'])

# ---- official notices (RSS)
FEEDS = [
    ('SEBI', 'https://www.sebi.gov.in/sebirss.xml'),
    ('RBI', 'https://rbi.org.in/pressreleases_rss.xml'),
    ('RBI', 'https://rbi.org.in/notifications_rss.xml'),
    ('NSE', 'https://nsearchives.nseindia.com/content/RSS/Circulars.xml'),
]
# Drop routine / individual-case notices; keep rules, circulars, policy and market-structure items
DROP = re.compile(r'appeal no|notice of demand|recovery certificate|adjudication order|settlement order|final order|order in the matter|attachment of bank|completion (order|of recovery)|release order|money market operations|auction|vrrr|vrr |citizen.s charter|reserve money|weighted average|treasury bill|state government securities|buyback offer|penalty|imposes monetary|cancels the certificate|enforcement action|summary of|tender offer', re.I)
IMPORTANT = re.compile(r'mutual fund|\bamc\b|amfi|distribut|nifty|sensex|\bindex\b|indices|repo rate|monetary policy|liquidity|kyc|nominat|specialised investment|sif\b|portfolio manag|investment adviser|research analyst|debt|bond|inflation|investor|f&o|derivative|exclu|inclu|rebalanc|holiday|settlement cycle|expense ratio|tax|reit|invit|circular|master direction|regulations|framework|consultation', re.I)
def parse_date(d):
    d = (d or '').strip()
    for f in ('%a, %d %b %Y %H:%M:%S %z', '%a, %d %b %Y %H:%M:%S %Z', '%a, %d %b %Y %H:%M:%S', '%d %b %Y %H:%M:%S', '%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%Y'):
        try: return dt.datetime.strptime(d, f).date().isoformat()
        except Exception: pass
    m = re.search(r'(\d{1,2})[ -](\w{3})[a-z]*[ -,]+(\d{4})', d)
    if m:
        try: return dt.datetime.strptime(f'{m.group(1)} {m.group(2)[:3]} {m.group(3)}', '%d %b %Y').date().isoformat()
        except Exception: pass
    return ''
items, ferr, counts = [], [], {}
try: _prev = {(x['src'], x['title']): x.get('date', '') for x in json.load(open('data/official.json'))['items']}
except Exception: _prev = {}
for src, url in FEEDS:
    try:
        root = ET.fromstring(get(url)); n_all = n_kept = 0
        for it in root.iter('item'):
            n_all += 1
            t = (it.findtext('title') or '').strip(); l = (it.findtext('link') or '').strip()
            d = (it.findtext('pubDate') or '').strip(); desc = re.sub('<[^>]+>', ' ', it.findtext('description') or '').strip()
            if not t: continue
            if DROP.search(t): continue
            t = re.sub(r'\s+', ' ', t).replace('\u200b', '').strip()
            iso = parse_date(d) or parse_date(desc[:120]) or _prev.get((src, t)) or dt.datetime.now(IST).date().isoformat()  # undated: first day we saw it
            items.append({'src': src, 'title': t, 'url': l, 'date': iso,
                          'important': bool(IMPORTANT.search(t + ' ' + desc[:300]))}); n_kept += 1
        counts[url] = [n_all, n_kept]
    except Exception as e:
        ferr.append(f'{src} {url}: {str(e)[:80]}')
seen, uniq = set(), []
for i in sorted(items, key=lambda x: x['date'], reverse=True):
    k = (i['src'], i['title'])
    if k in seen: continue
    seen.add(k); uniq.append(i)
json.dump({'updated': out['updated'], 'items': uniq[:120], 'counts': counts, 'errors': ferr}, open('data/official.json', 'w'), ensure_ascii=False, indent=1)
print('official items:', len(uniq), 'errors:', ferr)
