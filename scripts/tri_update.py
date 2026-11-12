#!/usr/bin/env python3
"""
Fetch NSE Indices Total Return Index (TRI) history from niftyindices.com and store
MONTH-END values (last trading day of each month) in data/tri_monthly.json.

Source endpoint (same one the niftyindices.com "Historical Data" page uses):
  POST https://www.niftyindices.com/Backpage/getTotalReturnIndexString
  body: {"cinfo": "{'name':'NIFTY 50','startDate':'01-Jan-2005','endDate':'12-Nov-2026','indexName':'NIFTY 50'}"}
  response rows: {"Index Name", "Date": "11 Nov 2026", "TotalReturnsIndex": "38400.84", "NTR_Value": ...}

Rules:
- Never invent or interpolate values. If an index fails to download, its previous series is kept
  unchanged and the failure is recorded in data/tri_status.json.
- Values before an index's launch date are NSE's own back-calculated history (as published by NSE).
"""
import json, os, sys, time, datetime as dt, urllib.request, http.cookiejar

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'tri_monthly.json')
STATUS = os.path.join(ROOT, 'data', 'tri_status.json')
DAILY = os.path.join(ROOT, 'data', 'tri_daily.json')
# Category benchmarks also stored DAILY, so trailing returns can run to the latest date (not just month-end)
DAILY_SET = ['NIFTY 50', 'NIFTY 100', 'NIFTY 500', 'NIFTY LARGEMIDCAP 250', 'NIFTY MIDCAP 150',
             'NIFTY SMALLCAP 250', 'NIFTY500 MULTICAP 50:25:25']
BASE = 'https://www.niftyindices.com'
URL = BASE + '/Backpage/getTotalReturnIndexString'
START = '01-Jan-2005'

# key: (NSE name, group)
INDICES = {
    # Broad / category benchmarks
    'NIFTY 50': 'broad', 'NIFTY 100': 'broad', 'NIFTY 200': 'broad', 'NIFTY 500': 'broad',
    'NIFTY LARGEMIDCAP 250': 'broad', 'NIFTY MIDCAP 150': 'broad', 'NIFTY SMALLCAP 250': 'broad',
    'NIFTY500 MULTICAP 50:25:25': 'broad', 'NIFTY MIDSMALLCAP 400': 'broad', 'NIFTY TOTAL MARKET': 'broad',
    # Style / factor
    'NIFTY500 VALUE 50': 'style', 'NIFTY500 QUALITY 50': 'style', 'NIFTY500 MOMENTUM 50': 'style',
    'NIFTY200 QUALITY 30': 'style', 'NIFTY200 MOMENTUM 30': 'style', 'NIFTY100 LOW VOLATILITY 30': 'style',
    'NIFTY500 EQUAL WEIGHT': 'style', 'NIFTY ALPHA 50': 'style', 'NIFTY DIVIDEND OPPORTUNITIES 50': 'style',
    # Sector / theme (for sectoral funds and sector-cycle analysis later)
    'NIFTY BANK': 'sector', 'NIFTY PRIVATE BANK': 'sector', 'NIFTY PSU BANK': 'sector',
    'NIFTY FINANCIAL SERVICES': 'sector', 'NIFTY IT': 'sector', 'NIFTY PHARMA': 'sector',
    'NIFTY FMCG': 'sector', 'NIFTY AUTO': 'sector', 'NIFTY INFRASTRUCTURE': 'sector',
    'NIFTY ENERGY': 'sector', 'NIFTY METAL': 'sector', 'NIFTY REALTY': 'sector', 'NIFTY PSE': 'sector',
    'NIFTY INDIA CONSUMPTION': 'sector', 'NIFTY INDIA MANUFACTURING': 'sector', 'NIFTY MNC': 'sector',
    'NIFTY COMMODITIES': 'sector', 'NIFTY SERVICES SECTOR': 'sector', 'NIFTY INDIA DEFENCE': 'sector',
}

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'


def opener():
    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [('User-Agent', UA), ('Accept-Language', 'en-US,en;q=0.9')]
    try:  # pick up any session cookies first
        op.open(BASE + '/reports/historical-data', timeout=40).read()
    except Exception as e:  # not fatal; the POST may still work
        print('warm-up failed:', e)
    return op


def fetch(op, name, end):
    cinfo = "{'name':'%s','startDate':'%s','endDate':'%s','indexName':'%s'}" % (name, START, end, name)
    req = urllib.request.Request(URL, data=json.dumps({'cinfo': cinfo}).encode(), method='POST', headers={
        'Content-Type': 'application/json; charset=UTF-8', 'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest', 'Origin': BASE, 'Referer': BASE + '/reports/historical-data'})
    raw = op.open(req, timeout=90).read().decode('utf-8', 'replace')
    j = json.loads(raw)
    if isinstance(j, dict) and 'd' in j:
        j = j['d']
    if isinstance(j, str):
        j = json.loads(j)
    if not isinstance(j, list) or not j:
        raise ValueError('empty or unexpected response: ' + raw[:150])
    rows = []
    for r in j:
        d = dt.datetime.strptime(r['Date'].strip(), '%d %b %Y').date()
        v = float(str(r['TotalReturnsIndex']).replace(',', ''))
        if v > 0:
            rows.append((d, v))
    rows.sort()
    return rows, j[0].get('Index Name', name)


def month_end(rows):
    """Last available trading-day value in each calendar month (no interpolation)."""
    last = {}
    for d, v in rows:
        last[(d.year, d.month)] = (d, v)
    return [[d.isoformat(), round(v, 2)] for _, (d, v) in sorted(last.items())]


def main():
    today = dt.date.today()
    end = today.strftime('%d-%b-%Y')
    try:
        old = json.load(open(OUT))
    except Exception:
        old = {'indices': {}}
    data = {
        'source': 'NSE Indices Ltd (niftyindices.com), Total Return Index, endpoint /Backpage/getTotalReturnIndexString',
        'note': 'Month-end = last trading day of each month. The current month holds the latest available day. '
                'Values before an index launch are NSE back-calculated history.',
        'fetched': today.isoformat(),
        'indices': dict(old.get('indices', {})),
    }
    status = {'run': dt.datetime.utcnow().isoformat(timespec='seconds') + 'Z', 'ok': 0, 'failed': 0, 'detail': {}}
    try:
        daily = json.load(open(DAILY))
    except Exception:
        daily = {'indices': {}}
    daily.update({'source': data['source'], 'fetched': today.isoformat(),
                  'format': 'per index: base date + day gaps (t, delta-encoded) + TRI values (v)'})
    op = opener()
    for name, group in INDICES.items():
        try:
            rows, echo = fetch(op, name, end)
            data['indices'][name] = {'label': echo, 'group': group, 'first_day': rows[0][0].isoformat(),
                                     'last_day': rows[-1][0].isoformat(), 'm': month_end(rows)}
            if name in DAILY_SET:
                base = rows[0][0]; prev = base; t = []
                for d, _ in rows:
                    t.append((d - prev).days); prev = d
                daily['indices'][name] = {'base': base.isoformat(), 't': t, 'v': [round(v, 2) for _, v in rows]}
            status['ok'] += 1
            status['detail'][name] = 'ok %d days %s..%s' % (len(rows), rows[0][0], rows[-1][0])
        except Exception as e:
            status['failed'] += 1
            status['detail'][name] = 'FAILED: %s' % (str(e)[:200])
        time.sleep(1.0)
    if status['ok']:
        json.dump(data, open(OUT, 'w'), separators=(',', ':'))
        json.dump(daily, open(DAILY, 'w'), separators=(',', ':'))
    json.dump(status, open(STATUS, 'w'), indent=1)
    print(json.dumps(status, indent=1))


if __name__ == '__main__':
    main()
