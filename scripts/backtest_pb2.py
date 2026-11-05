"""Second profit-booking test: which signals were followed by WEAKER markets (good moments to book),
compared with the average day? Signals: (a) rally of X% from the low since the last signal,
(b) index Z% above its 200-day average, (c) trailing fall Y% after a rally (from test 1)."""
import json, urllib.request, urllib.parse, datetime as dt, statistics as st
UA = {'User-Agent': 'Mozilla/5.0'}
SYMS = {'Nifty 50': '^NSEI', 'Nifty 500': '^CRSLDX', 'Midcap 150': 'NIFTYMIDCAP150.NS', 'Smallcap 250': 'NIFTYSMLCAP250.NS'}
P1 = int(dt.datetime(2019, 1, 1).timestamp()); P2 = int(dt.datetime.now().timestamp())
def closes(sym):
    u = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?period1={P1}&period2={P2}&interval=1d'
    r = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30))['chart']['result'][0]
    return [(dt.datetime.utcfromtimestamp(t + 19800).date(), c) for t, c in zip(r['timestamp'], r['indicators']['quote'][0]['close']) if c]
def fwd(rows, i, n): return rows[i + n][1] / rows[i][1] - 1 if i + n < len(rows) else None
def dip(rows, i, n): return min(x[1] for x in rows[i:i + n]) / rows[i][1] - 1 if i + n < len(rows) else None
def stats(rows, idx, label):
    f3 = [fwd(rows, i, 63) for i in idx]; f6 = [fwd(rows, i, 126) for i in idx]; d6 = [dip(rows, i, 126) for i in idx]
    f3 = [x for x in f3 if x is not None]; f6 = [x for x in f6 if x is not None]; d6 = [x for x in d6 if x is not None]
    if not f6: return
    yrs = (rows[-1][0] - rows[0][0]).days / 365.25
    print(f"  {label:<34} n={len(idx):>3} ({len(idx)/yrs:.1f}/yr)  +3m {st.mean(f3)*100:>5.1f}%  +6m {st.mean(f6)*100:>5.1f}%  lower after 6m {sum(x<0 for x in f6)/len(f6)*100:>3.0f}%  dip within 6m {st.mean(d6)*100:>5.1f}%  dip ≥5%: {sum(x<=-0.05 for x in d6)/len(d6)*100:>3.0f}%")
for name, sym in SYMS.items():
    rows = closes(sym)
    ma = {}
    for i in range(199, len(rows)): ma[i] = sum(r[1] for r in rows[i-199:i+1]) / 200
    start = next(i for i, r in enumerate(rows) if r[0] >= dt.date(2020, 1, 1))
    R = rows; print(f'\n##### {name}  {R[start][0]} → {R[-1][0]}')
    stats(R, list(range(start, len(R))), 'ANY DAY (baseline)')
    for X in [5, 7, 10, 12, 15, 20]:
        sig = []; lo = R[start][1]; cool = -1
        for i in range(start, len(R)):
            lo = min(lo, R[i][1])
            if R[i][1] >= lo * (1 + X / 100): sig.append(i); lo = R[i][1]
        stats(R, sig, f'rally +{X}% from recent low')
    for Z in [5, 8, 10, 12, 15, 20]:
        sig = []; last = -999
        for i in range(start, len(R)):
            if R[i][1] >= ma[i] * (1 + Z / 100) and i - last > 20: sig.append(i); last = i
        stats(R, sig, f'{Z}% above 200-day average')
