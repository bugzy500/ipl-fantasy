"""
Backfill dot balls for all completed matches using IPL official S3 feed.

- Skips matches that already have dotBalls > 0 (guard in update_dot_balls_from_ipl)
- Skips matches already processed (iplMatchId set)
- After patching dots, triggers recompute_fantasy_scores for affected matches
- Dry-run mode: --dry-run flag shows what would be updated without writing

Usage:
    python3 backfill_dotballs_ipl.py             # live run
    python3 backfill_dotballs_ipl.py --dry-run   # preview only
"""
import os, sys, subprocess, argparse
sys.path.insert(0, os.path.dirname(__file__))

# Load env
with open('/opt/services/ipl-backend/.env') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ[k.strip()] = v.strip()

from pymongo import MongoClient
from ipl_official_feed import IPLOfficialFeed, IPLFeedError

parser = argparse.ArgumentParser()
parser.add_argument('--dry-run', action='store_true', help='Preview only, no DB writes')
args = parser.parse_args()

DRY_RUN = args.dry_run
if DRY_RUN:
    print("=== DRY RUN MODE — no writes ===\n")

client = MongoClient(os.environ['MONGO_URI'])
db = client['test']

# Build players_by_name (same logic as scraper)
all_players = list(db.players.find({}))
pbn = {}
for p in all_players:
    n = p['name'].strip().lower()
    pbn[n] = p
    parts = n.split()
    if len(parts) > 1:
        pbn[parts[-1]] = p
    for a in p.get('aliases', []):
        ac = a.strip().lower()
        pbn[ac] = p
        ap = ac.split()
        if len(ap) > 1:
            pbn[ap[-1]] = p

print(f"Players loaded: {len(all_players)} | Name map entries: {len(pbn)}")
print()

# Get all completed matches
matches = list(db.matches.find({'status': 'completed'}).sort('scheduledAt', 1))
print(f"Completed matches: {len(matches)}")
print()

# Shared IPL feed client
ipl_client = IPLOfficialFeed(season='2026')

# Pre-fetch matchlinks once
print("Fetching IPL matchlinks...")
links = ipl_client.fetch_match_links()
print(f"Found {len(links)} matches in IPL feed\n")

updated_matches = []
skipped = []
failed = []

for m in matches:
    mid = m['_id']
    t1 = m.get('team1', '?')
    t2 = m.get('team2', '?')
    date = str(m.get('scheduledAt', ''))[:10]
    label = f"{t1} vs {t2} ({date})"

    # Check if already has iplMatchId
    if m.get('iplMatchId'):
        print(f"  SKIP  {label} — iplMatchId already set ({m['iplMatchId']})")
        skipped.append(label)
        continue

    # Check if already has dot ball data
    existing_dots = db.playerperformances.find_one({
        'matchId': mid,
        'oversBowled': {'$gt': 0},
        'dotBalls': {'$gt': 0},
    })
    if existing_dots:
        print(f"  SKIP  {label} — dot balls already populated (ESPN data)")
        skipped.append(label)
        continue

    # Check teams exist
    if not t1 or not t2:
        print(f"  SKIP  {label} — missing team abbreviations")
        skipped.append(label)
        continue

    # Find match in IPL feed
    link = ipl_client.find_match_by_teams(t1, t2)
    if not link:
        ipl_client.fetch_match_links(force_refresh=True)
        link = ipl_client.find_match_by_teams(t1, t2)

    if not link:
        print(f"  FAIL  {label} — not found in IPL matchlinks feed")
        failed.append(label)
        continue

    print(f"  FOUND {label} — smId={link.match_id}")

    if DRY_RUN:
        # Just show what we'd fetch
        try:
            scoreboard = ipl_client.fetch_scoreboard(link.match_id)
            dots_preview = {}
            for inn in scoreboard.innings:
                for bowler in inn.bowling:
                    clean = bowler.name.split('(')[0].strip().lower()
                    if clean:
                        dots_preview[clean] = dots_preview.get(clean, 0) + bowler.dot_balls
            print(f"         Would patch {len(dots_preview)} bowlers:")
            for name, dots in sorted(dots_preview.items()):
                matched = pbn.get(name)
                match_status = f"-> {matched['name']}" if matched else "NOT MATCHED"
                print(f"           {name}: {dots} dots  {match_status}")
        except Exception as e:
            print(f"         Dry-run fetch failed: {e}")
        continue

    # Live run — call the function from scraper
    try:
        scoreboard = ipl_client.fetch_scoreboard(link.match_id)
    except IPLFeedError as e:
        print(f"  FAIL  {label} — IPL fetch error: {e}")
        failed.append(label)
        continue

    if len(scoreboard.innings) < 2:
        print(f"  FAIL  {label} — only {len(scoreboard.innings)} innings in feed")
        failed.append(label)
        continue

    # Aggregate dots
    dots_by_name = {}
    for inn in scoreboard.innings:
        for bowler in inn.bowling:
            clean = bowler.name.split('(')[0].strip().lower()
            if clean:
                dots_by_name[clean] = dots_by_name.get(clean, 0) + bowler.dot_balls

    # Match and write
    patched = 0
    unmatched = []
    for clean_name, dots in dots_by_name.items():
        player = pbn.get(clean_name)
        if not player:
            unmatched.append(clean_name)
            continue
        result = db.playerperformances.update_one(
            {'playerId': player['_id'], 'matchId': mid, 'oversBowled': {'$gt': 0}},
            {'$set': {'dotBalls': int(dots)}}
        )
        if result.modified_count > 0:
            patched += 1

    if unmatched:
        print(f"         Unmatched bowlers (add as aliases): {unmatched}")

    if patched > 0:
        # Stamp iplMatchId
        db.matches.update_one({'_id': mid}, {'$set': {'iplMatchId': link.match_id}})
        print(f"  OK    {label} — {patched} bowlers patched, iplMatchId={link.match_id}")
        updated_matches.append({'id': str(mid), 'label': label})
    else:
        print(f"  WARN  {label} — 0 records patched (check bowler name aliases)")
        failed.append(label)

print()
print('=' * 60)
print(f"Summary:")
print(f"  Skipped (already have data):  {len(skipped)}")
print(f"  Updated:                      {len(updated_matches)}")
print(f"  Failed/unmatched:             {len(failed)}")

if updated_matches and not DRY_RUN:
    print()
    print("Now recomputing fantasy scores for updated matches...")
    for m in updated_matches:
        print(f"  Recomputing: {m['label']}")
        result = subprocess.run(
            ['node', 'recompute_fantasy_scores.js', '--apply', '--match', m['id']],
            cwd='/opt/services/ipl-backend/scripts',
            capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"    OK: {result.stdout.strip()[:120]}")
        else:
            print(f"    ERROR: {result.stderr.strip()[:200]}")

print()
print("Done.")
