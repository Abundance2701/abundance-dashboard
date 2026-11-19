#!/usr/bin/env python3
"""
Fetch NSE index valuation history (P/E, P/B, dividend yield, as published by NSE) from niftyindices.com
and store MONTH-END values in data/pe_monthly.json. Used by the Fund Selector's client review page to
show how expensive mid and small caps are compared with large caps, against their own history.

Source: the niftyindices.com "Historical Data → P/E, P/B & Div. Yield" page's own endpoint.
Rules (same as tri_update.py):
- Never invent or interpolate values. If an index fails, its previous series is kept and the failure is
  recorded in the file's "status" block.
- Fetched in one-year chunks (the endpoint can refuse long ranges).
"""
import json, os, time, datetime as dt, urllib.request, http.cookiejar

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'pe_monthly.json')
BASE = 'https://www.niftyindices.com'
PATHS = ['/Backpage/getpepbHistoricaldataDBtoString', '/Backpage.aspx/getpepbHistoricaldataDBtoString']
INDICES = ['NIFTY 50', 'NIFTY 100', 'NIFTY 500', 'NIFTY MIDCAP 150', 'NIFTY SMALLCAP 250', 'NIFTY MIDCAP 100', 'NIFTY SMALLCAP 100']
# NSE's valuation endpoint sometimes uses a shorter name; tried in order, stored under the first name
ALIASES = {'NIFTY SMALLCAP 250': ['NIFTY SMALLCAP 250', 'NIFTY SMLCAP 250', 'Nifty Smallcap 250'], 'NIFTY SMALLCAP 100': ['NIFTY SMALLCAP 100', 'NIFTY SMLCAP 100'], 'NIFTY MIDCAP 100': ['NIFTY MIDCAP 100']}
START_YEAR = 2005
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'


def opener():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [('User-Agent', UA), ('Accept-Language', 'en-US,en;q=0.9')]
    try:
        op.open(BASE + '/reports/historical-data', timeout=40).read()
    except Exception as e:
        print('warm-up failed:', e)
    return op


def num(v):
    try:
        x = float(str(v).replace(',', '').strip())
        return x if x > 0 else None
    except Exception:
        return None


def parse_rows(raw):
    j = json.loads(raw)
    if isinstance(j, dict) and 'd' in j:
        j = j['d']
    if isinstance(j, str):
        j = json.loads(j)
    if not isinstance(j, list):
        raise ValueError('unexpected response: ' + raw[:150])
    out = []
    for r in j:
        lk = {k.lower().replace(' ', '').replace('.', ''): v for k, v in r.items()}
        dkey = next((k for k in lk if 'date' in k), None)
        if not dkey:
            continue
        ds = str(lk[dkey]).strip()
        d = None
        for f in ('%d %b %Y', '%d-%b-%Y', '%Y-%m-%d', '%d %B %Y'):
            try:
                d = dt.datetime.strptime(ds[:11] if f != '%d %B %Y' else ds, f).date(); break
            except Exception:
                pass
        if not d:
            continue
        pe = num(lk.get('pe')); pb = num(lk.get('pb'))
        dy = num(next((v for k, v in lk.items() if k.startswith('div')), None))
        if pe:
            out.append((d, pe, pb, dy))
    return out


def fetch(op, path, name, s, e):
    cinfo = "{'name':'%s','startDate':'%s','endDate':'%s','indexName':'%s'}" % (name, s, e, name)
    req = urllib.request.Request(BASE + path, data=json.dumps({'cinfo': cinfo}).encode(), method='POST', headers={
        'Content-Type': 'application/json; charset=UTF-8', 'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest', 'Origin': BASE, 'Referer': BASE + '/reports/historical-data'})
    return parse_rows(op.open(req, timeout=90).read().decode('utf-8', 'replace'))


def main():
    old = {}
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT))
        except Exception:
            old = {}
    series = old.get('series', {})
    status = {}
    op = opener()
    today = dt.date.today()
    path_ok = None
    for name in INDICES:
        rows, errs = [], []
        prev = series.get(name) or []
        first = today.year - 1 if len(prev) > 100 else START_YEAR   # daily runs only refresh the last two years
        for y in range(first, today.year + 1):
            s = dt.date(y, 1, 1).strftime('%d-%b-%Y'); e = min(dt.date(y, 12, 31), today).strftime('%d-%b-%Y')
            got = None
            for p in ([path_ok] if path_ok else PATHS):
                for attempt in range(2):
                    try:
                        for alias in ALIASES.get(name, [name]):
                            got = fetch(op, p, alias, s, e)
                            if got:
                                break
                        path_ok = p; break
                    except Exception as ex:
                        errs.append(f'{y} {p}: {ex}'[:160]); time.sleep(2)
                if got is not None:
                    break
            if got:
                rows += got
            time.sleep(0.6)
        if len(rows) < 24:
            status[name] = {'ok': False, 'rows': len(rows), 'errors': errs[-4:]}
            print(name, 'FAILED', errs[-3:])
            continue
        rows.sort()
        me = {x[0][:7]: x for x in prev} if first != START_YEAR else {}
        for d, pe, pb, dy in rows:   # keep the last trading day of each month
            me[d.strftime('%Y-%m')] = [d.isoformat(), pe, pb, dy]
        series[name] = [me[k] for k in sorted(me)]
        status[name] = {'ok': True, 'months': len(me), 'from': series[name][0][0], 'to': series[name][-1][0]}
        print(name, 'ok', status[name])
    out = {'source': 'niftyindices.com Historical Data: P/E, P/B & Div. Yield (as published by NSE), month-end values',
           'fields': ['date', 'pe', 'pb', 'divYield'], 'updated': today.isoformat(), 'endpoint': path_ok,
           'status': status, 'series': series}
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()
