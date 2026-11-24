"""Latest-month Total Expense Ratio (TER) of every open-ended MF scheme, from AMFI (amfiindia.com/ter-of-mf-schemes).
Writes data/ter.json: {month, src, rows:[{n: scheme name, c: category, isin..., reg: Regular total TER %, dir: Direct total TER %}]}
On any failure the old file is kept. Raw response saved to data/ter_raw_sample.json (first rows) to check the field names."""
import json, sys, urllib.request, urllib.parse, datetime
B = 'https://www.amfiindia.com'
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
     'Accept': 'application/json, text/plain, */*', 'Referer': B + '/ter-of-mf-schemes'}
def get(path, **q):
    req = urllib.request.Request(B + path + '?' + urllib.parse.urlencode(q), headers=H)
    with urllib.request.urlopen(req, timeout=90) as r: return json.loads(r.read().decode('utf-8', 'replace'))
t = datetime.date.today(); fy = f"{t.year}-{t.year+1}" if t.month >= 4 else f"{t.year-1}-{t.year}"
months = get('/api/populate-ter-month', year=fy)
print('months', months[:3])
m = months[0]['MonthNumber']
data = get('/api/populate-te-rdata-revised', MF_ID='All', Month=m, strCat='-1', strType='-1')
print('top', type(data).__name__, list(data.keys()) if isinstance(data, dict) else '', {k: v for k, v in data.items() if k != 'data'} if isinstance(data, dict) else '')
recs = data if isinstance(data, list) else data.get('data', data)
for extra in ({'page': 2}, {'pageNumber': 2}, {'PageNo': 2}, {'pageSize': 5000}, {'PageSize': 5000}, {'limit': 5000}):
    try:
        d2 = get('/api/populate-te-rdata-revised', MF_ID='All', Month=m, strCat='-1', strType='-1', **extra)
        r2 = d2 if isinstance(d2, list) else d2.get('data', d2); print('try', extra, len(r2), r2[0].get('Scheme_Name') if r2 else '')
    except Exception as e: print('try', extra, e)
print('records', len(recs)); print(json.dumps(recs[:2], indent=1)[:3000])
json.dump({'month': m, 'sample': recs[:5], 'keys': sorted({k for r in recs[:200] for k in r})}, open('data/ter_raw_sample.json', 'w'), indent=1)
def pick(r, *subs):
    for k, v in r.items():
        kl = k.lower()
        if all(s in kl for s in subs): return v
def num(v):
    try: return round(float(str(v).replace('%', '').strip()), 2)
    except: return None
rows = []
for r in recs:
    reg = num(pick(r, 'regular', 'total')); dr = num(pick(r, 'direct', 'total'))
    n = pick(r, 'scheme', 'name') or pick(r, 'scheme')
    if n and (reg is not None or dr is not None):
        rows.append({'n': str(n).strip(), 'c': str(pick(r, 'sub') or pick(r, 'categ') or ''), 'mf': str(pick(r, 'mutual') or pick(r, 'amc') or ''), 'reg': reg, 'dir': dr})
if len(rows) < 500: print('too few rows parsed', len(rows)); sys.exit(1)
json.dump({'month': m, 'src': 'AMFI TER of MF schemes (monthly average)', 'rows': rows}, open('data/ter.json', 'w'), separators=(',', ':'))
print('wrote', len(rows))
