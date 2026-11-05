"""Profit-booking rule backtest (research only, run by hand from GitHub Actions).
Rule per index: from the lowest close since the last review, a rise of X% 'arms' the rule;
after that, a fall of Y% from the highest close since arming = 'review now' signal; the
reference then resets to that day. Scores each (X, Y) on how much it would have helped
someone booking profits: how close to the top it exits, and what the index did afterwards."""
import json, urllib.request, datetime as dt, statistics as st, sys
UA = {'User-Agent': 'Mozilla/5.0'}
SYMS = {'Nifty 50': ['^NSEI'], 'Nifty 500': ['^CRSLDX', 'NIFTY500.NS'], 'Midcap 150': ['NIFTYMIDCAP150.NS', '^NIFTYMIDCAP150'], 'Smallcap 250': ['NIFTYSMLCAP250.NS', '^NIFTYSMLCAP250']}
P1 = int(dt.datetime(2019, 12, 1).timestamp()); P2 = int(dt.datetime.now().timestamp())
def closes(sym):
    u = f'https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?period1={P1}&period2={P2}&interval=1d'
    r = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30))['chart']['result'][0]
    q = r['indicators']['quote'][0]['close']
    return [(dt.datetime.utcfromtimestamp(t + 19800).date(), c) for t, c in zip(r['timestamp'], q) if c]
import urllib.parse
def run(rows, X, Y):
    sig = []; lo = rows[0][1]; armed = False; pk = None; ref_i = 0
    for i, (d, c) in enumerate(rows):
        if not armed:
            lo = min(lo, c)
            if c >= lo * (1 + X / 100): armed = True; pk = c; pk_i = i; base = lo
        else:
            if c > pk: pk = c; pk_i = i
            if c <= pk * (1 - Y / 100):
                f = lambda n: rows[min(i + n, len(rows) - 1)][1] / c - 1 if i + n < len(rows) else None
                later_max = max(x[1] for x in rows[i:i + 126]) if i + 1 < len(rows) else c
                sig.append({'date': str(d), 'exit': round(c, 1), 'peak': round(pk, 1), 'peak_date': str(rows[pk_i][0]),
                            'from_peak': (c / pk - 1) * 100, 'locked_from_low': (c / base - 1) * 100,
                            'f63': f(63), 'f126': f(126), 'dd126': min(x[1] for x in rows[i:i + 126]) / c - 1,
                            'reentry_gap': None})
                armed = False; lo = c
    return sig
out = {}
for name, cands in SYMS.items():
    rows = None
    for s in cands:
        try:
            rows = closes(s)
            if len(rows) > 500: break
        except Exception as e: print(name, s, 'failed', e)
    if not rows: continue
    rows = [r for r in rows if r[0] >= dt.date(2020, 1, 1)]
    yrs = (rows[-1][0] - rows[0][0]).days / 365.25
    print(f'\n##### {name}: {rows[0][0]} → {rows[-1][0]} ({len(rows)} days), {rows[0][1]:.0f} → {rows[-1][1]:.0f}')
    res = []
    for X in [3, 4, 5, 6, 7, 8, 10, 12, 15]:
        for Y in [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8]:
            s = run(rows, X, Y)
            done = [x for x in s if x['f126'] is not None]
            if not done: continue
            res.append({'X': X, 'Y': Y, 'n': len(s), 'per_yr': len(s) / yrs,
                        'avg_from_peak': st.mean(x['from_peak'] for x in s),
                        'avg_f63': st.mean(x['f63'] for x in s if x['f63'] is not None) * 100,
                        'avg_f126': st.mean(x['f126'] for x in done) * 100,
                        'hit126': sum(1 for x in done if x['f126'] < 0) / len(done) * 100,
                        'avg_dd126': st.mean(x['dd126'] for x in done) * 100,
                        'avg_locked': st.mean(x['locked_from_low'] for x in s), 'sig': s})
    print('  X%  Y%  signals/yr  exit-vs-peak  locked-from-low  idx+3m  idx+6m  lower-after-6m  worst-dip-in-6m')
    for r in sorted(res, key=lambda r: (r['X'], r['Y'])):
        print(f"  {r['X']:>3} {r['Y']:>4}  {r['per_yr']:>6.1f}      {r['avg_from_peak']:>6.1f}%       {r['avg_locked']:>6.1f}%     {r['avg_f63']:>6.1f}% {r['avg_f126']:>6.1f}%     {r['hit126']:>5.0f}%        {r['avg_dd126']:>6.1f}%")
    out[name] = {'from': str(rows[0][0]), 'to': str(rows[-1][0]), 'res': res}
    # buy-and-hold reference
    print(f'  hold: {(rows[-1][1]/rows[0][1]-1)*100:.0f}% total')
for name in out:
    for r in out[name]['res']:
        if (name, r['X'], r['Y']) in [('Nifty 50', 5, 3), ('Nifty 500', 6, 3), ('Midcap 150', 7, 4), ('Smallcap 250', 8, 5)]:
            print(f"\n--- {name} X={r['X']} Y={r['Y']} signals:")
            for s in r['sig']: print(f"   {s['date']} exit {s['exit']} (peak {s['peak']} on {s['peak_date']}, {s['from_peak']:.1f}%), locked {s['locked_from_low']:.1f}% from low, +6m {('%.1f%%' % (s['f126']*100)) if s['f126'] is not None else 'n/a'}, worst dip 6m {s['dd126']*100:.1f}%")
json.dump(out, open('backtest_pb.json', 'w'), default=str)
