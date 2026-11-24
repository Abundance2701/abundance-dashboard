"""Total Expense Ratio (TER) of every open-ended MF scheme, from AMFI (amfiindia.com/ter-of-mf-schemes).
AMFI gives one row per scheme per day; we keep each scheme's latest day in the latest month.
Writes data/ter.json: {month, asof, src, rows:[{n, c, mf, reg, dir}]} (reg/dir = Regular/Direct total TER %).
On any failure the old file is kept."""
import json, sys, io, urllib.request, urllib.parse, datetime
B = 'https://www.amfiindia.com'
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
     'Accept': 'application/json, text/plain, */*', 'Referer': B + '/ter-of-mf-schemes'}
def raw(path, **q):
    req = urllib.request.Request(B + path + '?' + urllib.parse.urlencode(q), headers=H)
    with urllib.request.urlopen(req, timeout=180) as r: return r.read()
get = lambda path, **q: json.loads(raw(path, **q).decode('utf-8', 'replace'))
t = datetime.date.today(); fy = f"{t.year}-{t.year+1}" if t.month >= 4 else f"{t.year-1}-{t.year}"
m = get('/api/populate-ter-month', year=fy)[0]['MonthNumber']
q = dict(MF_ID='All', Month=m, strCat='-1', strType='-1')
import time
def fetch(size, p):
    for k in range(6):
        try: return get('/api/populate-te-rdata-revised', **q, pageSize=size, page=p)
        except Exception as e:
            err = e; time.sleep(min(60, 5 * 2 ** k) if '429' in str(e) else 3)
    print('page failed', p, err); return None
# biggest page the API will give, so there are few calls (AMFI rate-limits with HTTP 429)
for size in (5000, 2000, 1000, 500, 100):
    first = fetch(size, 1)
    if first and len(first.get('data') or []) >= min(size, (first.get('meta') or {}).get('total', size)): break
meta = first.get('meta', {}); print('meta', meta, 'pageSize', size)
recs = list(first['data']); pages = meta.get('pageCount', 1)
for p in range(2, pages + 1):
    d = fetch(size, p)
    if d is None: sys.exit(f'page {p} failed; old file kept')
    recs += d['data']; time.sleep(1)
print('records', len(recs), 'of', meta.get('total'))
latest = {}
for r in recs:
    if (r.get('SchemeType_Desc') or '').lower() != 'open ended': continue
    k = r.get('NSDLSchemeCode') or r.get('Scheme_Name')
    if k not in latest or (r.get('TER_Date') or '') > (latest[k].get('TER_Date') or ''): latest[k] = r
def num(v):
    try: return round(float(v), 2)
    except: return None
rows = [{'n': r['Scheme_Name'].strip(), 'c': r.get('SchemeCat_Desc') or '', 'mf': r.get('MF_ID'), 'reg': num(r.get('R_TER')), 'dir': num(r.get('D_TER')), 'd': (r.get('TER_Date') or '')[:10]} for r in latest.values()]
print('records kept', len(recs))
if len(rows) < 800: sys.exit(f'too few schemes: {len(rows)}')
asof = max(x['d'] for x in rows)
json.dump({'month': m, 'asof': asof, 'src': 'AMFI, TER of MF schemes (total TER incl. GST, latest day per scheme)', 'rows': rows}, open('data/ter.json', 'w'), separators=(',', ':'))
print('wrote', len(rows), 'schemes, latest', asof)
