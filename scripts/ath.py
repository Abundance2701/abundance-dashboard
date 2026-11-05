"""Research helper: all-time high (close and intraday) of the main indices, from Yahoo daily data."""
import json, urllib.request, urllib.parse, datetime as dt
for name, sym in [('Nifty 50', '^NSEI'), ('Nifty 500', '^CRSLDX'), ('Midcap 150', 'NIFTYMIDCAP150.NS'), ('Smallcap 250', 'NIFTYSMLCAP250.NS')]:
    u = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=10y&interval=1d'
    r = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))['chart']['result'][0]
    q = r['indicators']['quote'][0]; ts = r['timestamp']
    rows = [(dt.datetime.utcfromtimestamp(t + 19800).date(), c, h) for t, c, h in zip(ts, q['close'], q['high']) if c and h]
    mc = max(rows, key=lambda x: x[1]); mh = max(rows, key=lambda x: x[2])
    print(f'{name}: last {rows[-1][1]:.2f} on {rows[-1][0]} | highest close {mc[1]:.2f} on {mc[0]} | highest intraday {mh[2]:.2f} on {mh[0]}')
