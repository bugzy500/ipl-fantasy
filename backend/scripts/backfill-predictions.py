#!/usr/bin/env python3
"""
Backfill match results + prediction evaluation for completed matches.

Uses ESPN API to get match results, then evaluates predictions and
recalculates fantasy team totals including prediction bonus.

Usage:
  python3 backfill-predictions.py          # dry-run
  python3 backfill-predictions.py --apply  # apply changes
"""
import os, sys, requests, re
from bson import ObjectId

# ─── Env ───
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
if not MONGO_URI:
    print("No MONGO_URI found")
    sys.exit(1)

import pymongo
client = pymongo.MongoClient(MONGO_URI)
db = client["test"]

APPLY = "--apply" in sys.argv

ESPN_API = "https://site.api.espn.com/apis/site/v2/sports/cricket/8048"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

# Full team name → abbreviation
FULL_TEAM_NAMES = {
    "chennai super kings": "CSK", "mumbai indians": "MI",
    "royal challengers bengaluru": "RCB", "royal challengers bangalore": "RCB",
    "kolkata knight riders": "KKR", "rajasthan royals": "RR",
    "delhi capitals": "DC", "sunrisers hyderabad": "SRH",
    "punjab kings": "PBKS", "kings xi punjab": "PBKS",
    "lucknow super giants": "LSG", "gujarat titans": "GT",
}

def get_espn_schedule():
    """Fetch IPL 2026 schedule from ESPN."""
    r = requests.get(f"{ESPN_API}/scoreboard?dates=2026&limit=100", headers=HEADERS, timeout=15)
    events = r.json().get("events", [])
    schedule = []
    for ev in events:
        comps = ev.get("competitions", [{}])
        competitors = comps[0].get("competitors", []) if comps else []
        teams = [c.get("team", {}).get("abbreviation", "") for c in competitors]
        winner = None
        status_text = ""
        for c in competitors:
            if c.get("winner"):
                winner = c.get("team", {}).get("abbreviation", "")
        # Get status/result text
        status_obj = ev.get("status", {})
        status_text = status_obj.get("type", {}).get("detail", "")
        if not status_text:
            status_text = ev.get("name", "")
        detail = status_obj.get("type", {}).get("detail", "")
        is_done = status_obj.get("type", {}).get("completed", False) or detail.lower() == "final" or winner is not None
        schedule.append({
            "espn_id": ev.get("id"),
            "teams": teams,
            "date": ev.get("date", "")[:10],
            "winner": winner,
            "status_text": status_text if status_text else detail,
            "completed": is_done,
        })
    return schedule

def find_espn_match(match, schedule):
    """Find ESPN event for a DB match."""
    t1 = match.get("team1", "").upper()
    t2 = match.get("team2", "").upper()
    for ev in schedule:
        ev_teams = set(t.upper() for t in ev["teams"])
        if t1 in ev_teams and t2 in ev_teams and ev["completed"]:
            return ev
    return None

def extract_winner_from_result(result_text, match):
    """Extract winning team abbreviation from result string."""
    if not result_text:
        return None
    rt = result_text.lower()
    if "won" not in rt and "beat" not in rt:
        return None
    for full_name, abbr in FULL_TEAM_NAMES.items():
        if full_name in rt:
            return abbr
    t1 = match.get("team1", "")
    t2 = match.get("team2", "")
    if t1.lower() in rt:
        return t1
    if t2.lower() in rt:
        return t2
    return None

def apply_multiplier(base, is_cap, is_vc):
    if is_cap:
        return base * 2
    if is_vc:
        return base * 1.5
    return base

# ─── Main ───
print("Fetching ESPN schedule...")
schedule = get_espn_schedule()
print(f"  Got {len(schedule)} events")

completed_matches = list(db.matches.find({"status": "completed"}))
print(f"\n{len(completed_matches)} completed matches in DB\n")

for match in completed_matches:
    t1, t2 = match["team1"], match["team2"]
    match_id = match["_id"]
    print(f"{'='*50}")
    print(f"{t1} vs {t2}")

    # Step 1: Get result from ESPN
    espn = find_espn_match(match, schedule)
    if not espn:
        print(f"  No ESPN match found — skipping")
        continue

    result_text = espn.get("status_text", "")
    winner = espn.get("winner")  # ESPN gives us winner directly
    if not winner:
        winner = extract_winner_from_result(result_text, match)

    current_result = match.get("result", "")
    current_winner = match.get("winner")
    print(f"  ESPN result: '{result_text}' | winner: {winner}")
    print(f"  DB   result: '{current_result}' | winner: {current_winner}")

    # Step 2: Update match result/winner
    if (not current_result or not current_winner) and winner:
        print(f"  {'[DRY] ' if not APPLY else ''}Setting result='{result_text}', winner='{winner}'")
        if APPLY:
            db.matches.update_one({"_id": match_id}, {"$set": {"result": result_text, "winner": winner}})

    if not winner:
        print(f"  No winner determined — skipping prediction eval")
        continue

    # Step 3: Evaluate predictions
    preds = list(db.predictions.find({"matchId": match_id}))
    correct_count = 0
    for pred in preds:
        if pred.get("predictionType") == "superover":
            is_correct = "super over" in result_text.lower()
            bonus = 80 if is_correct else 0
        else:
            is_correct = pred.get("predictedWinner") == winner
            bonus = 25 if is_correct else 0

        if is_correct:
            correct_count += 1

        old_correct = pred.get("isCorrect")
        old_bonus = pred.get("bonusPoints", 0)
        if old_correct != is_correct or old_bonus != bonus:
            user = db.users.find_one({"_id": pred["userId"]})
            name = user.get("name", "?") if user else "?"
            print(f"  {'[DRY] ' if not APPLY else ''}Prediction {name}: {pred.get('predictedWinner')} → correct={is_correct} bonus={bonus} (was correct={old_correct} bonus={old_bonus})")
            if APPLY:
                db.predictions.update_one({"_id": pred["_id"]}, {"$set": {"isCorrect": is_correct, "bonusPoints": bonus}})

    print(f"  Predictions: {len(preds)} total, {correct_count} correct")

    # Step 4: Recalculate team totals with prediction bonus
    prediction_bonus = {}
    for pred in preds:
        uid = str(pred["userId"])
        if pred.get("predictionType") == "superover":
            is_correct = "super over" in result_text.lower()
            bonus = 80 if is_correct else 0
        else:
            is_correct = pred.get("predictedWinner") == winner
            bonus = 25 if is_correct else 0
        prediction_bonus[uid] = prediction_bonus.get(uid, 0) + bonus

    # Get player points
    perfs = list(db.playerperformances.find({"matchId": match_id}))
    players = list(db.players.find({}))
    pid_to_player = {str(p["_id"]): p for p in players}

    # Import scoring (inline since this is a standalone script)
    def calculate_fantasy_points(perf, role):
        pts = 0.0
        # Batting
        runs = perf.get("runs", 0)
        balls = perf.get("ballsFaced", 0)
        pts += runs * 1.0
        pts += perf.get("fours", 0) * 1.0
        pts += perf.get("sixes", 0) * 2.0
        if runs >= 100: pts += 16.0
        elif runs >= 50: pts += 8.0
        elif runs >= 30: pts += 4.0
        if perf.get("isDismissed") and runs == 0 and perf.get("didBat"): pts -= 2.0
        if balls >= 10:
            sr = (runs / balls) * 100
            if sr >= 170: pts += 6.0
            elif sr >= 150: pts += 4.0
            elif sr >= 130: pts += 2.0
            elif sr < 50: pts -= 6.0
            elif sr < 60: pts -= 4.0
            elif sr < 70: pts -= 2.0
        # Bowling
        wk = perf.get("wickets", 0)
        pts += wk * 25.0
        pts += perf.get("lbwBowledWickets", 0) * 8.0
        pts += perf.get("dotBalls", 0) * 2.0
        pts += perf.get("maidens", 0) * 12.0
        if wk >= 5: pts += 16.0
        elif wk >= 4: pts += 8.0
        elif wk >= 3: pts += 4.0
        ob = perf.get("oversBowled", 0)
        if ob >= 2:
            eco = perf.get("runsConceded", 0) / ob
            if eco <= 5: pts += 6.0
            elif eco <= 6: pts += 4.0
            elif eco <= 7: pts += 2.0
            elif eco >= 12: pts -= 6.0
            elif eco >= 11: pts -= 4.0
            elif eco >= 10: pts -= 2.0
        # Fielding
        c = perf.get("catches", 0)
        pts += c * 8.0
        if c >= 3: pts += 4.0
        pts += perf.get("stumpings", 0) * 12.0
        pts += perf.get("runOutDirect", 0) * 12.0
        pts += perf.get("runOutIndirect", 0) * 6.0
        return round(pts, 1)

    player_points = {}
    for perf in perfs:
        pid = str(perf["playerId"])
        p = pid_to_player.get(pid)
        role = p.get("role", "batsman") if p else "batsman"
        pts = calculate_fantasy_points(perf, role)
        player_points[pid] = pts
        # Also fix fantasyPoints if wrong
        if pts != perf.get("fantasyPoints", 0):
            print(f"  {'[DRY] ' if not APPLY else ''}Perf fix: {p['name'] if p else pid} {perf.get('fantasyPoints',0)} → {pts}")
            if APPLY:
                db.playerperformances.update_one({"_id": perf["_id"]}, {"$set": {"fantasyPoints": pts}})

    teams = list(db.fantasyteams.find({"matchId": match_id}))
    updated_teams = 0
    for team in teams:
        total = 0.0
        for p_id in team.get("players", []):
            base = player_points.get(str(p_id), 0)
            is_cap = str(team.get("captain")) == str(p_id)
            is_vc = str(team.get("viceCaptain")) == str(p_id)
            total += apply_multiplier(base, is_cap, is_vc)
        # Add prediction bonus
        uid = str(team.get("userId"))
        total += prediction_bonus.get(uid, 0)
        total = round(total, 1)

        if total != team.get("totalPoints", 0):
            user = db.users.find_one({"_id": team["userId"]})
            name = user.get("name", "?") if user else "?"
            bonus_str = f" (includes +{prediction_bonus.get(uid, 0)} pred)" if prediction_bonus.get(uid, 0) else ""
            print(f"  {'[DRY] ' if not APPLY else ''}Team {name}: {team['totalPoints']} → {total}{bonus_str}")
            if APPLY:
                db.fantasyteams.update_one({"_id": team["_id"]}, {"$set": {"totalPoints": total}})
            updated_teams += 1

    print(f"  Teams: {len(teams)} total, {updated_teams} need update")

client.close()
print(f"\n{'DRY RUN — pass --apply to make changes' if not APPLY else 'ALL CHANGES APPLIED'}")
