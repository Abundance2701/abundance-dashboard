"""Assemble Market Pulse data for the web page.
Input : pulse/days/YYYY-MM-DD.json  -> {"day": {...}, "items": [...]}   (one file per trading day)
        pulse/events.json            -> [{"date","title","note"}]
Output: market-pulse.json (latest 30 days + events) and archive/YYYY-MM.json (every day of that month).
Run from the repo root: python scripts/build_pulse.py
"""
import json, glob, os, datetime as dt
days, items = [], []
for f in sorted(glob.glob('pulse/days/*.json')):
    try: j = json.load(open(f, encoding='utf-8'))
    except Exception as e: print('skip', f, e); continue
    d = j.get('day') or {}
    date = d.get('date') or os.path.basename(f)[:10]; d['date'] = date
    days.append(d)
    for i, it in enumerate(j.get('items') or []):
        it['date'] = date; it.setdefault('rank', i + 1); items.append(it)
days.sort(key=lambda d: d['date'], reverse=True)
try: events = json.load(open('pulse/events.json', encoding='utf-8'))
except Exception: events = []
cut = (dt.date.today() - dt.timedelta(days=45)).isoformat()
events = sorted([e for e in events if e.get('date', '') >= cut], key=lambda e: e['date'])
now = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
recent = {d['date'] for d in days[:30]}
json.dump({'updated': now, 'days': days[:30], 'items': [i for i in items if i['date'] in recent], 'events': events,
           'archive': sorted({d['date'][:7] for d in days}, reverse=True)},
          open('market-pulse.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
os.makedirs('archive', exist_ok=True)
for m in {d['date'][:7] for d in days}:
    json.dump({'month': m, 'days': [d for d in days if d['date'][:7] == m], 'items': [i for i in items if i['date'][:7] == m]},
              open(f'archive/{m}.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('days', len(days), 'items', len(items), 'events', len(events))
