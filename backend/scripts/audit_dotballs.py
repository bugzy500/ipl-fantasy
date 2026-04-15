"""Audit dot ball data for all completed matches and backfill using IPL official feed."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))

# Load env
with open('/opt/services/ipl-backend/.env') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ[k.strip()] = v.strip()

from pymongo import MongoClient
client = MongoClient(os.environ['MONGO_URI'])
db = client['test']

matches = list(db.matches.find({'status': 'completed'}, {
    'team1': 1, 'team2': 1, 'scheduledAt': 1, 'espnMatchId': 1, 'iplMatchId': 1
}).sort('scheduledAt', 1))

print(f"Total completed matches: {len(matches)}")
print()
print(f"{'Date':<12} {'Match':<22} {'Bowlers':<9} {'WithDots':<10} {'TotalDots':<11} {'Status'}")
print('-' * 75)

needs_update = []
for m in matches:
    mid = m['_id']
    t1 = m.get('team1', '?')
    t2 = m.get('team2', '?')
    date = str(m.get('scheduledAt', ''))[:10]
    ipl_id = m.get('iplMatchId')

    perfs = list(db.playerperformances.find(
        {'matchId': mid, 'oversBowled': {'$gt': 0}},
        {'dotBalls': 1}
    ))
    total_bowlers = len(perfs)
    with_dots = sum(1 for p in perfs if p.get('dotBalls', 0) > 0)
    total_dots = sum(p.get('dotBalls', 0) for p in perfs)

    if with_dots == 0:
        status = 'MISSING'
        needs_update.append(m)
    elif ipl_id:
        status = 'OK (ipl)'
    else:
        status = 'OK (espn)'

    match_str = f"{t1} vs {t2}"
    print(f"{date:<12} {match_str:<22} {total_bowlers:<9} {with_dots:<10} {total_dots:<11} {status}")

print()
print(f"Matches needing dot ball update: {len(needs_update)}")
for m in needs_update:
    print(f"  - {m.get('team1')} vs {m.get('team2')} ({str(m.get('scheduledAt',''))[:10]})")
