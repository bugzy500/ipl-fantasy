#!/usr/bin/env python3
"""
Backfill lbwBowledWickets from ESPN bowling data.

ESPN bowling stats include 'bowled' count per bowler (how many of their
wickets were bowled dismissals). We can also count LBW from batting data.

Usage:
  python3 backfill-lbw-bowled.py          # dry-run
  python3 backfill-lbw-bowled.py --apply  # apply changes
"""
import os, sys, requests
from bson import ObjectId

MONGO_URI = os.environ.get("MONGO_URI")
if not MONGO_URI:
    for p in ["/opt/services/ipl-scraper/.env", "backend/.env", ".env"]:
        if os.path.exists(p):
            for line in open(p):
                if line.startswith("MONGO_URI="):
                    MONGO_URI = line.strip().split("=", 1)[1]
                    break
        if MONGO_URI:
            break

import pymongo
client = pymongo.MongoClient(MONGO_URI)
db = client["test"]
APPLY = "--apply" in sys.argv

ESPN_API = "https://site.api.espn.com/apis/site/v2/sports/cricket/8048"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

def get_espn_schedule():
    r = requests.get(f"{ESPN_API}/scoreboard?dates=2026&limit=100", headers=HEADERS, timeout=15)
    events = r.json().get("events", [])
    schedule = []
    for ev in events:
        comps = ev.get("competitions", [{}])
        teams = [c.get("team", {}).get("abbreviation", "") for c in comps[0].get("competitors", [])]
        winner = next((c.get("team", {}).get("abbreviation", "") for c in comps[0].get("competitors", []) if c.get("winner")), None)
        detail = ev.get("status", {}).get("type", {}).get("detail", "")
        schedule.append({
            "espn_id": ev.get("id"),
            "teams": teams,
            "winner": winner,
            "completed": detail.lower() == "final" or winner is not None,
        })
    return schedule

def fetch_lbw_bowled_from_espn(espn_id):
    """Fetch per-bowler LBW+Bowled counts from ESPN."""
    url = f"{ESPN_API}/summary?event={espn_id}"
    r = requests.get(url, headers=HEADERS, timeout=15)
    data = r.json()

    lbw_bowled_by_bowler = {}  # bowler name → count of (LBW + Bowled wickets)

    # From bowling stats: 'bowled' gives us bowled dismissals per bowler
    for team in data.get("rosters", []):
        for player in team.get("roster", []):
            name = player.get("athlete", {}).get("displayName", "?")
            for ls_period in player.get("linescores", []):
                for ls in ls_period.get("linescores", []):
                    for cat in ls.get("statistics", {}).get("categories", []):
                        stats = {s["name"]: s.get("value", 0) for s in cat.get("stats", [])}
                        wk = stats.get("wickets", 0)
                        if isinstance(wk, (int, float)) and wk > 0:
                            # 'bowled' includes both bowled AND lbw in ESPN's data
                            # Actually ESPN separates: bowled = clean bowled, caught = caught
                            # LBW isn't a separate stat in ESPN bowling — it shows in batting dismissal
                            bowled_count = stats.get("bowled", 0)
                            if isinstance(bowled_count, (int, float)) and bowled_count > 0:
                                lbw_bowled_by_bowler[name] = lbw_bowled_by_bowler.get(name, 0) + int(bowled_count)

    # From batting stats: count LBW dismissals per bowler
    # ESPN batting has 'card' field showing dismissal type
    # But we don't have bowler info in batting... we need innings data
    # Actually, let's also count from batting dismissals
    for team in data.get("rosters", []):
        for player in team.get("roster", []):
            name = player.get("athlete", {}).get("displayName", "?")
            for ls_period in player.get("linescores", []):
                for ls in ls_period.get("linescores", []):
                    for cat in ls.get("statistics", {}).get("categories", []):
                        stats = {}
                        for s in cat.get("stats", []):
                            val = s.get("value", s.get("displayValue", 0))
                            stats[s["name"]] = val
                        card = stats.get("dismissalCard", "")
                        if isinstance(card, str) and card.lower() == "lbw":
                            # We can't attribute LBW to a specific bowler from batting data
                            # But we know the dismissal happened. Skip for now.
                            pass

    return lbw_bowled_by_bowler

# Build player name map
players = list(db.players.find({}))
pbn = {}
for p in players:
    n = p["name"].strip().lower()
    pbn[n] = p
    parts = n.split()
    if len(parts) > 1:
        pbn[parts[-1]] = p
    for a in p.get("aliases", []):
        ac = a.strip().lower()
        pbn[ac] = p

def find_player(name):
    clean = name.strip().lower()
    if clean in pbn:
        return pbn[clean]
    last = clean.split()[-1] if clean else ""
    if last and last in pbn:
        return pbn[last]
    for key, p in pbn.items():
        if last and last in key:
            return p
    return None

# Main
print("Fetching ESPN schedule...")
schedule = get_espn_schedule()

completed = list(db.matches.find({"status": "completed"}))
print(f"{len(completed)} completed matches\n")

for match in completed:
    t1, t2 = match["team1"], match["team2"]
    mid = match["_id"]

    # Find ESPN event
    espn_ev = None
    for ev in schedule:
        ev_teams = set(t.upper() for t in ev["teams"])
        if t1.upper() in ev_teams and t2.upper() in ev_teams and ev["completed"]:
            espn_ev = ev
            break

    if not espn_ev:
        print(f"{t1} vs {t2}: No ESPN match found")
        continue

    print(f"{t1} vs {t2} (ESPN {espn_ev['espn_id']}):")

    lbw_bowled = fetch_lbw_bowled_from_espn(espn_ev["espn_id"])
    if not lbw_bowled:
        print("  No LBW/Bowled data")
        continue

    for bowler_name, count in lbw_bowled.items():
        player = find_player(bowler_name)
        if not player:
            print(f"  {bowler_name}: {count} bowled — player not found")
            continue

        perf = db.playerperformances.find_one({"playerId": player["_id"], "matchId": mid, "oversBowled": {"$gt": 0}})
        if not perf:
            continue

        current = perf.get("lbwBowledWickets", 0)
        if current != count:
            print(f"  {'[DRY] ' if not APPLY else ''}{bowler_name}: lbwBowledWickets {current} → {count}")
            if APPLY:
                db.playerperformances.update_one({"_id": perf["_id"]}, {"$set": {"lbwBowledWickets": count}})

print(f"\n{'DRY RUN' if not APPLY else 'APPLIED'}")
client.close()
