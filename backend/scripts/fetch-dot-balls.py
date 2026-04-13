#!/usr/bin/env python3
"""
Fetch dot balls from ESPN Cricket API → update MongoDB PlayerPerformance.

Neither CricAPI nor Cricbuzz scorecard provides dot ball counts.
This script fetches bowling stats from ESPN's public API (which includes dots),
matches bowlers to players in MongoDB, and patches PlayerPerformance.dotBalls.

Usage:
  python3 fetch-dot-balls.py --espn-id=1527687 --match-id=69cd08419ee8c327e6082c83 [--dry-run]
  python3 fetch-dot-balls.py --espn-id=1527687 --cb-id=149746 [--dry-run]
  python3 fetch-dot-balls.py --all [--dry-run]   # process all matches with espnMatchId

Data source:
  https://site.api.espn.com/apis/site/v2/sports/cricket/8048/summary?event={espn_event_id}
  IPL league ID = 8048

After running, recompute fantasy points:
  node scripts/recompute_fantasy_scores.js --match=<matchId> --apply
"""
import os, sys, json, requests
from pathlib import Path

# ─── Env ───
for _env_path in [
    Path(__file__).parent / '.env',
    Path('/opt/services/ipl-scraper/.env'),
    Path(__file__).parent.parent / '.env',
]:
    if _env_path.exists():
        for line in _env_path.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())
        break

try:
    from pymongo import MongoClient
    from bson import ObjectId
except ImportError:
    print("ERROR: pymongo not installed. Run: pip3 install pymongo")
    sys.exit(1)

MONGO_URI = os.environ.get('MONGO_URI', '')
ESPN_API = "https://site.api.espn.com/apis/site/v2/sports/cricket/8048/summary"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
}


# ─── ESPN API ───

def fetch_bowling_dots(espn_event_id):
    """
    Fetch dot balls per bowler from ESPN Cricket API.
    Returns: { "Bowler Name": dots_count, ... }
    """
    url = f"{ESPN_API}?event={espn_event_id}"
    resp = requests.get(url, headers=HEADERS, timeout=15)
    if resp.status_code != 200:
        print(f"  ESPN API returned {resp.status_code}")
        return {}

    data = resp.json()
    dots_by_bowler = {}

    for team in data.get('rosters', []):
        team_name = team.get('team', {}).get('displayName', '?')

        for player in team.get('roster', []):
            name = player.get('athlete', {}).get('displayName', '?')

            for ls_period in player.get('linescores', []):
                for ls in ls_period.get('linescores', []):
                    for cat in ls.get('statistics', {}).get('categories', []):
                        stats = {s['name']: s.get('value', 0) for s in cat.get('stats', [])}
                        overs = stats.get('overs', 0)
                        dots = stats.get('dots', 0)

                        if overs > 0 and dots > 0:
                            # Accumulate across innings (in case someone bowls in both)
                            dots_by_bowler[name] = dots_by_bowler.get(name, 0) + dots
                            print(f"  {team_name:20s} | {name:25s} | ov={overs} r={stats.get('conceded',0)} w={stats.get('wickets',0)} DOTS={dots}")

    return dots_by_bowler


def fetch_espn_schedule(series_id=1510719):
    """
    Fetch IPL schedule from ESPN to map matches to event IDs.
    Returns: list of {espn_id, team1, team2, date, ...}
    """
    url = f"https://site.api.espn.com/apis/site/v2/sports/cricket/8048/scoreboard?dates=2026&limit=100"
    resp = requests.get(url, headers=HEADERS, timeout=15)
    if resp.status_code != 200:
        return []

    data = resp.json()
    matches = []
    for event in data.get('events', []):
        espn_id = event.get('id')
        teams = [c.get('team', {}).get('abbreviation', '') for c in event.get('competitions', [{}])[0].get('competitors', [])]
        date = event.get('date', '')
        name = event.get('name', '')
        matches.append({
            'espn_id': espn_id,
            'teams': teams,
            'date': date,
            'name': name,
        })
    return matches


# ─── MongoDB ───

def find_match(db, cb_id=None, mongo_match_id=None):
    """Find the match in MongoDB."""
    if mongo_match_id:
        match = db.matches.find_one({"_id": ObjectId(mongo_match_id)})
        if match:
            return match

    if cb_id:
        match = db.matches.find_one({"cricApiMatchId": str(cb_id)})
        if match:
            return match

    return None


def match_bowler_to_player(db, bowler_name, players_cache):
    """Match an ESPN bowler name to a player in the DB."""
    if not players_cache.get('_loaded'):
        for p in db.players.find({}):
            name = p["name"].strip().lower()
            players_cache[name] = p
            parts = name.split()
            if len(parts) > 1:
                players_cache[parts[-1]] = p
            for alias in p.get("aliases", []):
                alias_clean = alias.strip().lower()
                players_cache[alias_clean] = p
                alias_parts = alias_clean.split()
                if len(alias_parts) > 1:
                    players_cache[alias_parts[-1]] = p
        players_cache['_loaded'] = True

    clean = bowler_name.strip().lower()

    # Exact match
    if clean in players_cache:
        return players_cache[clean]

    # Last name match
    last = clean.split()[-1] if clean else ""
    if last and last in players_cache:
        return players_cache[last]

    # Partial match on last name
    for key, p in players_cache.items():
        if key == '_loaded':
            continue
        if last and last in key:
            return p

    return None


def update_dot_balls(db, match_id, dots_by_bowler, dry_run=False):
    """Update PlayerPerformance.dotBalls for each bowler."""
    players_cache = {}
    updated = 0
    skipped = []

    for bowler_name, dots in sorted(dots_by_bowler.items(), key=lambda x: -x[1]):
        player = match_bowler_to_player(db, bowler_name, players_cache)
        if not player:
            skipped.append(bowler_name)
            print(f"  SKIP: {bowler_name} ({dots} dots) — no DB match")
            continue

        perf = db.playerperformances.find_one({
            "playerId": player["_id"],
            "matchId": match_id,
        })

        if not perf:
            print(f"  SKIP: {bowler_name} → {player['name']} — no performance record")
            continue

        current_dots = perf.get("dotBalls", 0)
        if dots == current_dots:
            print(f"  OK:     {bowler_name:25s} → {player['name']:25s} | dots={dots} (already correct)")
        else:
            print(f"  UPDATE: {bowler_name:25s} → {player['name']:25s} | dots: {current_dots} → {dots}")
            if not dry_run:
                db.playerperformances.update_one(
                    {"_id": perf["_id"]},
                    {"$set": {"dotBalls": dots}}
                )
                updated += 1

    if skipped:
        print(f"\n  WARNING: {len(skipped)} bowlers not matched: {skipped}")

    return updated


# ─── Main ───

def process_match(db, espn_event_id, match_id=None, cb_id=None, dry_run=False):
    """Fetch dots from ESPN and update MongoDB for one match."""
    print(f"\n  Fetching ESPN event {espn_event_id}...")
    dots_by_bowler = fetch_bowling_dots(espn_event_id)

    if not dots_by_bowler:
        print("  ERROR: No bowling dot data from ESPN API.")
        return 0

    print(f"\n  Dot balls summary:")
    total = 0
    for bowler, dots in sorted(dots_by_bowler.items(), key=lambda x: -x[1]):
        print(f"    {bowler:25s}: {dots}")
        total += dots
    print(f"    {'TOTAL':25s}: {total}")

    # Find match in MongoDB
    match = find_match(db, cb_id, match_id)
    if not match:
        print(f"\n  ERROR: No match found in DB" +
              (f" (matchId={match_id})" if match_id else "") +
              (f" (cbId={cb_id})" if cb_id else ""))
        return 0

    print(f"\n  Match: {match.get('team1')} vs {match.get('team2')} ({match['_id']})")
    print(f"  Status: {match.get('status')}")

    # Store ESPN event ID on the match for future use
    if not dry_run and not match.get('espnMatchId'):
        db.matches.update_one(
            {"_id": match["_id"]},
            {"$set": {"espnMatchId": str(espn_event_id)}}
        )
        print(f"  Saved espnMatchId={espn_event_id} on match")

    # Update dot balls
    print(f"\n  {'DRY RUN — ' if dry_run else ''}Updating PlayerPerformance.dotBalls:")
    updated = update_dot_balls(db, match["_id"], dots_by_bowler, dry_run)
    print(f"\n  Updated {updated} records" + (" (dry run)" if dry_run else ""))

    return updated


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0)

    dry_run = '--dry-run' in args
    espn_id = None
    match_id = None
    cb_id = None

    for a in args:
        if a.startswith('--espn-id='):
            espn_id = a.split('=', 1)[1]
        elif a.startswith('--match-id='):
            match_id = a.split('=', 1)[1]
        elif a.startswith('--cb-id='):
            cb_id = a.split('=', 1)[1]

    print(f"=== Dot Ball Fetcher (ESPN API) ===")
    print(f"  Mode: {'DRY RUN' if dry_run else 'LIVE — will update DB'}")

    if not MONGO_URI:
        print("\nERROR: MONGO_URI not set. Check .env file.")
        sys.exit(1)

    client = MongoClient(MONGO_URI)
    db = client.get_default_database()

    if espn_id:
        updated = process_match(db, espn_id, match_id, cb_id, dry_run)
    else:
        print("ERROR: --espn-id is required. Find it from ESPNcricinfo match URL.")
        print("  Example: https://www.espncricinfo.com/.../14th-match-1527687/full-scorecard")
        print("  The number at the end (1527687) is the ESPN event ID.")
        client.close()
        sys.exit(1)

    if not dry_run and updated > 0:
        mid = match_id or str(find_match(db, cb_id, match_id).get('_id', ''))
        print(f"\n  Next: recompute fantasy points:")
        print(f"    cd backend && node scripts/recompute_fantasy_scores.js --match={mid} --apply")

    client.close()


if __name__ == "__main__":
    main()
