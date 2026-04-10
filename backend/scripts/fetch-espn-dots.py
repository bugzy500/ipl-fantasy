#!/usr/bin/env python3
"""
One-off: Fetch dot balls from ESPN for a specific completed match.
Run on VPS: cd /opt/services/ipl-scraper && python3 fetch-espn-dots.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pymongo import MongoClient
from bson import ObjectId

# Import from the scraper
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location("scraper", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipl-scraper.py"))
scraper = module_from_spec(spec)

# We need to load the scraper module to get its functions
# But loading the whole module runs main() — so we'll just inline the ESPN logic
import requests

MONGO_URI = os.environ.get('MONGO_URI', 'SET_MONGO_URI_IN_ENV')
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
ESPN_API_URL = "https://site.api.espn.com/apis/site/v2/sports/cricket/8048"

MATCH_ID = "69cd08419ee8c327e6082c86"


def calculate_fantasy_points(perf, role):
    """Scoring rules — mirrors scraper's calculate_fantasy_points."""
    pts = 0.0
    pts += perf.get("runs", 0) * 1.0
    pts += perf.get("fours", 0) * 1.0
    pts += perf.get("sixes", 0) * 2.0
    runs = perf.get("runs", 0)
    balls = perf.get("ballsFaced", 0)
    if balls >= 10:
        sr = (runs / balls) * 100
        if sr >= 170: pts += 6
        elif sr >= 150: pts += 4
        elif sr >= 130: pts += 2
        elif sr < 50: pts -= 6
        elif sr < 60: pts -= 4
        elif sr < 70: pts -= 2
    if runs >= 100: pts += 16
    elif runs >= 50: pts += 8
    elif runs >= 30: pts += 4
    if runs == 0 and balls >= 1:
        if role in ("BAT", "WK"):
            pts -= 4
        elif role == "AR":
            pts -= 2
    wickets = perf.get("wickets", 0)
    pts += wickets * 25.0
    pts += perf.get("maidens", 0) * 8.0
    overs = perf.get("oversBowled", 0)
    if overs >= 2:
        er = perf.get("runsConceded", 0) / overs
        if er <= 5.0: pts += 6
        elif er <= 6.0: pts += 4
        elif er <= 7.0: pts += 2
        elif er >= 12.0: pts -= 6
        elif er >= 10.0: pts -= 4
        elif er >= 9.0: pts -= 2
    if wickets >= 5: pts += 16
    elif wickets >= 4: pts += 8
    elif wickets >= 3: pts += 4
    pts += perf.get("lbwBowledWickets", 0) * 8.0
    pts += perf.get("dotBalls", 0) * 2.0
    pts += perf.get("catches", 0) * 8.0
    pts += perf.get("stumpings", 0) * 12.0
    runOuts = perf.get("runOuts", 0)
    pts += runOuts * 12.0
    runOutsIndirect = perf.get("runOutsIndirect", 0)
    pts += runOutsIndirect * 6.0
    return round(pts, 1)


def apply_multiplier(base, is_captain, is_vc):
    if is_captain: return base * 2.0
    if is_vc: return base * 1.5
    return base


def find_espn_event_id(match):
    """Find ESPN event ID by matching teams + date."""
    if match.get("espnMatchId"):
        return match["espnMatchId"]

    print("Fetching ESPN IPL 2026 schedule...")
    r = requests.get(f"{ESPN_API_URL}/scoreboard?dates=2026&limit=100", headers=HEADERS, timeout=15)
    if r.status_code != 200:
        print(f"ESPN schedule returned {r.status_code}")
        return None

    data = r.json()
    schedule = []
    for ev in data.get("events", []):
        comps = ev.get("competitions", [{}])
        teams = [c.get("team", {}).get("abbreviation", "") for c in comps[0].get("competitors", [])]
        schedule.append({
            "espn_id": ev.get("id"),
            "teams": teams,
            "date": ev.get("date", ""),
        })

    t1 = match.get("team1", "").upper()[:3]
    t2 = match.get("team2", "").upper()[:3]
    match_date = str(match.get("scheduledAt", ""))[:10]

    for ev in schedule:
        teams_upper = [t.upper() for t in ev["teams"]]
        ev_date = ev["date"][:10]
        if t1 in teams_upper and t2 in teams_upper and match_date in ev_date:
            return ev["espn_id"]

    # Relaxed: just match teams
    for ev in schedule:
        teams_upper = [t.upper() for t in ev["teams"]]
        if t1 in teams_upper and t2 in teams_upper:
            return ev["espn_id"]

    return None


def main():
    client = MongoClient(MONGO_URI)
    db = client["test"]

    match = db.matches.find_one({"_id": ObjectId(MATCH_ID)})
    if not match:
        print(f"Match {MATCH_ID} not found!")
        return

    print(f"Match: {match.get('team1')} vs {match.get('team2')} — status: {match.get('status')}")

    if match.get("status") != "completed":
        print("Match not completed, skipping")
        return

    # Check if already patched
    has_dots = db.playerperformances.find_one({
        "matchId": ObjectId(MATCH_ID), "oversBowled": {"$gt": 0}, "dotBalls": {"$gt": 0}
    })
    if has_dots:
        print("Dot balls already patched for this match!")
        return

    # Find ESPN event
    espn_id = find_espn_event_id(match)
    if not espn_id:
        print(f"No ESPN event found for {match.get('team1')} vs {match.get('team2')}")
        return

    print(f"Found ESPN event ID: {espn_id}")
    print("Fetching dot ball data...")

    r = requests.get(f"{ESPN_API_URL}/summary?event={espn_id}", headers=HEADERS, timeout=15)
    if r.status_code != 200:
        print(f"ESPN API returned {r.status_code}")
        return

    data = r.json()
    dots_by_bowler = {}

    for team in data.get("rosters", []):
        for player in team.get("roster", []):
            name = player.get("athlete", {}).get("displayName", "")
            for ls_period in player.get("linescores", []):
                for ls in ls_period.get("linescores", []):
                    for cat in ls.get("statistics", {}).get("categories", []):
                        stats = {s["name"]: s.get("value", 0) for s in cat.get("stats", [])}
                        if stats.get("overs", 0) > 0 and stats.get("dots", 0) > 0:
                            dots_by_bowler[name] = dots_by_bowler.get(name, 0) + stats["dots"]

    if not dots_by_bowler:
        print("No dot ball data from ESPN!")
        return

    print(f"\nDot balls found for {len(dots_by_bowler)} bowlers:")
    for name, dots in sorted(dots_by_bowler.items(), key=lambda x: -x[1]):
        print(f"  {name}: {dots} dots")

    # Build player name map
    all_players = list(db.players.find({"franchise": {"$in": [match["team1"], match["team2"]]}}))
    players_by_name = {}
    for p in all_players:
        players_by_name[p["name"].strip().lower()] = p
        # Also add last name
        parts = p["name"].strip().lower().split()
        if len(parts) > 1:
            players_by_name[parts[-1]] = p

    updated = 0
    for bowler_name, dots in dots_by_bowler.items():
        clean = bowler_name.strip().lower()
        player = players_by_name.get(clean)
        if not player:
            last = clean.split()[-1] if clean else ""
            player = players_by_name.get(last)
        if not player:
            for key, p in players_by_name.items():
                if clean.split()[-1] in key:
                    player = p
                    break
        if not player:
            print(f"  SKIP: {bowler_name} — not found in DB")
            continue

        result = db.playerperformances.update_one(
            {"playerId": player["_id"], "matchId": ObjectId(MATCH_ID), "oversBowled": {"$gt": 0}},
            {"$set": {"dotBalls": dots}}
        )
        if result.modified_count > 0:
            print(f"  PATCHED: {bowler_name} → {player['name']} — {dots} dot balls")
            updated += 1
        else:
            print(f"  NO-OP: {bowler_name} → {player['name']} — no bowling perf found")

    # Store ESPN ID
    db.matches.update_one({"_id": ObjectId(MATCH_ID)}, {"$set": {"espnMatchId": str(espn_id)}})

    if updated > 0:
        print(f"\nRecalculating fantasy points for all players...")
        perfs = list(db.playerperformances.find({"matchId": ObjectId(MATCH_ID)}))
        players_list = list(db.players.find({}))
        pid_to_player = {str(p["_id"]): p for p in players_list}
        player_points = {}

        for perf in perfs:
            pid = str(perf["playerId"])
            p = pid_to_player.get(pid)
            role = p.get("role", "BAT") if p else "BAT"
            pts = calculate_fantasy_points(perf, role)
            if pts != perf.get("fantasyPoints", 0):
                db.playerperformances.update_one(
                    {"_id": perf["_id"]}, {"$set": {"fantasyPoints": pts}}
                )
                print(f"  {p['name'] if p else pid}: {perf.get('fantasyPoints', 0)} → {pts}")
            player_points[pid] = pts

        # Recalculate team totals
        print(f"\nRecalculating team totals...")
        for team in db.fantasyteams.find({"matchId": ObjectId(MATCH_ID)}):
            total = 0.0
            for p_id in team.get("players", []):
                base = player_points.get(str(p_id), 0)
                is_cap = str(team.get("captain")) == str(p_id)
                is_vc = str(team.get("viceCaptain")) == str(p_id)
                total += apply_multiplier(base, is_cap, is_vc)
            old = team.get("totalPoints", 0)
            new_total = round(total, 1)
            if old != new_total:
                db.fantasyteams.update_one({"_id": team["_id"]}, {"$set": {"totalPoints": new_total}})
                user = db.users.find_one({"_id": team["userId"]})
                name = user["name"] if user else str(team["userId"])
                print(f"  {name}: {old} → {new_total} ({'+' if new_total > old else ''}{round(new_total - old, 1)})")

        print(f"\nDone! {updated} bowlers patched with dot balls, points recalculated.")
    else:
        print("\nNo bowlers updated (all may already have dot balls or no bowling perfs found)")

    client.close()


if __name__ == "__main__":
    main()
