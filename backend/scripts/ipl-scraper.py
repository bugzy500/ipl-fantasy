#!/usr/bin/env python3
"""
IPL Live Score Scraper — Cricbuzz RSC → MongoDB → Fantasy Points → WhatsApp DMs

Extracts structured JSON scorecard data embedded in Cricbuzz's Next.js RSC payload.
No API key needed. Unlimited scraping.

Deploy: /opt/services/ipl-scraper/ipl-scraper.py
Cron:   */3 14-23 * * * /usr/bin/python3 /opt/services/ipl-scraper/ipl-scraper.py >> /var/log/ipl-scraper.log 2>&1
        */3 0-1 * * *   /usr/bin/python3 /opt/services/ipl-scraper/ipl-scraper.py >> /var/log/ipl-scraper.log 2>&1
"""
import re
import json
import time
import requests
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient
from bson import ObjectId

# ─── Config ───
MONGO_URI = "mongodb+srv://dmeetn2211_db_user:LoYQHcAHht8DRnjq@cluster0.jehizto.mongodb.net/test?retryWrites=true&w=majority&appName=Cluster0"
WA_URL = "https://wa.dotsai.cloud/api/send/text"
WA_TOKEN = "fc67ed20a9147dd45bc6c8c165e9acfafb381391c9e83f410ea54531f2ad719a"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
IST = timezone(timedelta(hours=5, minutes=30))
DM_INTERVAL_MIN = 15
STATE_FILE = "/opt/services/ipl-scraper/state.json"

# IPL team name → abbreviation map
TEAM_MAP = {
    "chennai super kings": "CSK", "mumbai indians": "MI",
    "kolkata knight riders": "KKR", "delhi capitals": "DC",
    "royal challengers bengaluru": "RCB", "royal challengers bangalore": "RCB",
    "rajasthan royals": "RR", "punjab kings": "PBKS",
    "sunrisers hyderabad": "SRH", "lucknow super giants": "LSG",
    "gujarat titans": "GT",
}


# ─── Scoring Rules (matches backend/src/services/scoring.service.js) ───
def calculate_fantasy_points(perf, role):
    pts = 0.0
    runs = perf.get("runs", 0)
    bf = perf.get("ballsFaced", 0)
    wk = perf.get("wickets", 0)
    overs = perf.get("oversBowled", 0)

    # Batting
    pts += runs * 1.0
    pts += perf.get("fours", 0) * 1.0
    pts += perf.get("sixes", 0) * 2.0
    if runs >= 100: pts += 16.0
    elif runs >= 50: pts += 8.0
    elif runs >= 30: pts += 4.0
    if perf.get("didBat") and runs == 0 and perf.get("isDismissed"):
        pts -= 2.0
    if bf >= 10:
        sr = (runs / bf) * 100
        if sr >= 170: pts += 6.0
        elif sr >= 150: pts += 4.0
        elif sr >= 130: pts += 2.0
        elif sr < 50: pts -= 6.0
        elif sr < 60: pts -= 4.0
        elif sr < 70: pts -= 2.0

    # Bowling
    pts += wk * 25.0
    pts += perf.get("lbwBowledWickets", 0) * 8.0
    pts += perf.get("maidens", 0) * 12.0
    if wk >= 5: pts += 16.0
    elif wk >= 4: pts += 8.0
    elif wk >= 3: pts += 4.0
    if overs >= 2:
        eco = perf.get("runsConceded", 0) / overs
        if eco < 5: pts += 6.0
        elif eco < 6: pts += 4.0
        elif eco < 7: pts += 2.0
        elif eco > 12: pts -= 6.0
        elif eco > 11: pts -= 4.0
        elif eco > 10: pts -= 2.0

    # Fielding
    pts += perf.get("catches", 0) * 8.0
    if perf.get("catches", 0) >= 3: pts += 4.0
    pts += perf.get("stumpings", 0) * 12.0
    pts += perf.get("runOutDirect", 0) * 12.0
    pts += perf.get("runOutIndirect", 0) * 6.0

    # Playing bonus
    if perf.get("didBat") or overs > 0:
        pts += 4.0
    return round(pts, 1)


def apply_multiplier(base, is_captain, is_vc):
    if is_captain: return base * 2.0
    if is_vc: return base * 1.5
    return base


# ─── State ───
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except:
        return {"last_dm": {}}

def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


# ─── WhatsApp ───
def send_dm(phone, message):
    if not phone:
        return False
    try:
        r = requests.post(WA_URL, json={"to": phone, "message": message},
                         headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                         timeout=10)
        return r.ok
    except:
        return False


# ─── Cricbuzz Scraping ───
def get_live_ipl_matches():
    """Get live IPL match IDs from Cricbuzz live scores page."""
    r = requests.get("https://www.cricbuzz.com/cricket-match/live-scores", headers=HEADERS, timeout=10)
    matches = []
    for match in re.findall(r'href="/live-cricket-scorecard/(\d+)/([^"]*indian-premier-league[^"]*)"', r.text):
        matches.append({"cb_id": match[0], "slug": match[1]})
    return matches


def extract_scorecard_json(cb_match_id):
    """
    Extract structured scorecard JSON from Cricbuzz's Next.js RSC streaming payload.
    The data is embedded in self.__next_f.push() calls as 'scorecardApiData'.
    """
    url = f"https://www.cricbuzz.com/live-cricket-scorecard/{cb_match_id}"
    r = requests.get(url, headers=HEADERS, timeout=15)

    # Extract all RSC streaming chunks
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', r.text)

    # Decode and join all chunks
    full_text = ""
    for chunk in chunks:
        try:
            decoded = chunk.encode("utf-8").decode("unicode_escape")
        except:
            decoded = chunk
        full_text += decoded

    # Find the scorecardApiData JSON blob
    # Pattern: "scorecardApiData":{"scoreCard":[...]}
    sc_match = re.search(r'"scorecardApiData"\s*:\s*(\{[^}]*"scoreCard"\s*:\s*\[)', full_text)
    if not sc_match:
        return None

    # Extract the full JSON object starting from scorecardApiData
    start = sc_match.start(1)
    # Use bracket counting to find the end of the JSON object
    depth = 0
    end = start
    for i in range(start, min(start + 200000, len(full_text))):
        c = full_text[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    json_str = full_text[start:end]

    try:
        data = json.loads(json_str)
        return data
    except json.JSONDecodeError as e:
        # Try to fix common issues (trailing commas, etc)
        # Fallback: extract scoreCard array directly
        sc_arr_match = re.search(r'"scoreCard"\s*:\s*(\[.*?\])\s*[,}]', json_str, re.DOTALL)
        if sc_arr_match:
            try:
                return {"scoreCard": json.loads(sc_arr_match.group(1))}
            except:
                pass
        print(f"    JSON parse error at char {e.pos}: {e.msg}")
        print(f"    Context: ...{json_str[max(0,e.pos-50):e.pos+50]}...")
        return None


def parse_scorecard(data):
    """
    Parse Cricbuzz scorecardApiData into our format.

    Structure:
      scoreCard[]: { matchId, inningsId, batTeamDetails: { batTeamName, batsmenData: { bat_1: {...}, ... } },
                     bowlTeamDetails: { bowlTeamName, bowlersData: { bowl_1: {...}, ... } },
                     scoreDetails: { runs, wickets, overs }, extrasData, wicketsData }

    Batsman: { batId, batName, runs, balls, fours, sixes, strikeRate, outDesc, wicketCode,
               bowlerId, fielderId1, fielderId2, fielderId3, isOverseas, isCaptain, isKeeper }
    Bowler: { bowlId, bowlName, overs, maidens, runs, wickets, economy, no_balls, wides }
    """
    if not data or "scoreCard" not in data:
        return None

    result = {"innings": [], "teams": [], "is_complete": False}

    # Check match status from matchHeader if available
    header = data.get("matchHeader", {})
    match_state = header.get("state", "").lower()
    result["is_complete"] = match_state == "complete" or "won" in header.get("status", "").lower()

    for innings in data["scoreCard"]:
        bat_team = innings.get("batTeamDetails", {})
        bowl_team = innings.get("bowlTeamDetails", {})
        team_name = bat_team.get("batTeamName", "Unknown")

        if team_name not in result["teams"]:
            result["teams"].append(team_name)
        bowl_team_name = bowl_team.get("bowlTeamName", "Unknown")
        if bowl_team_name not in result["teams"]:
            result["teams"].append(bowl_team_name)

        inn = {"team": team_name, "batting": [], "bowling": []}

        # Parse batsmen
        batsmen_data = bat_team.get("batsmenData", {})
        for key, bat in batsmen_data.items():
            if not isinstance(bat, dict):
                continue
            wicket_code = bat.get("wicketCode", "").upper()
            is_out = wicket_code not in ("", "NOT_OUT", "NOT OUT")

            inn["batting"].append({
                "cb_id": bat.get("batId"),
                "name": bat.get("batName", ""),
                "runs": bat.get("runs", 0),
                "balls": bat.get("balls", 0),
                "fours": bat.get("fours", 0),
                "sixes": bat.get("sixes", 0),
                "is_out": is_out,
                "wicket_code": wicket_code,  # CAUGHT, BOWLED, LBW, RUNOUT, STUMPED, etc.
                "out_desc": bat.get("outDesc", ""),
                "bowler_id": bat.get("bowlerId", 0),
                "fielder_id1": bat.get("fielderId1", 0),
                "fielder_id2": bat.get("fielderId2", 0),
                "is_captain": bat.get("isCaptain", False),
                "is_keeper": bat.get("isKeeper", False),
            })

        # Parse bowlers
        bowlers_data = bowl_team.get("bowlersData", {})
        for key, bowl in bowlers_data.items():
            if not isinstance(bowl, dict):
                continue
            inn["bowling"].append({
                "cb_id": bowl.get("bowlId"),
                "name": bowl.get("bowlName", ""),
                "overs": bowl.get("overs", 0),
                "maidens": bowl.get("maidens", 0),
                "runs": bowl.get("runs", 0),
                "wickets": bowl.get("wickets", 0),
                "economy": bowl.get("economy", 0),
            })

        result["innings"].append(inn)

    return result


# ─── MongoDB Integration ───
def update_match_scores(db, cb_match_id, scorecard):
    """Map parsed scorecard → PlayerPerformance → Fantasy points → Team scores."""

    teams = scorecard.get("teams", [])
    team_abbrs = [TEAM_MAP.get(t.lower(), t) for t in teams]

    # Find match in DB — check both team orders
    match = db.matches.find_one({"cricApiMatchId": str(cb_match_id)})
    if not match and len(team_abbrs) >= 2:
        # Try all combinations: exact, reversed, regex
        for t1, t2 in [(team_abbrs[0], team_abbrs[1]), (team_abbrs[1], team_abbrs[0])]:
            match = db.matches.find_one({"team1": t1, "team2": t2})
            if match:
                break
        if not match:
            # Regex fallback
            match = db.matches.find_one({
                "$or": [
                    {"team1": {"$regex": team_abbrs[0], "$options": "i"},
                     "team2": {"$regex": team_abbrs[1], "$options": "i"}},
                    {"team1": {"$regex": team_abbrs[1], "$options": "i"},
                     "team2": {"$regex": team_abbrs[0], "$options": "i"}},
                ]
            })
        if match:
            db.matches.update_one({"_id": match["_id"]}, {"$set": {"cricApiMatchId": str(cb_match_id)}})
            print(f"    Linked {match['team1']} vs {match['team2']} → CB#{cb_match_id}")

    if not match:
        print(f"    No DB match for CB#{cb_match_id} (teams: {team_abbrs}). Skipping.")
        return None

    match_id = match["_id"]

    # Update match status
    if scorecard.get("is_complete"):
        db.matches.update_one({"_id": match_id}, {"$set": {"status": "completed"}})
    elif any(inn["batting"] for inn in scorecard["innings"]):
        db.matches.update_one({"_id": match_id}, {"$set": {"status": "live"}})

    # Build player name → doc map (ALL players — franchise may have changed between seasons)
    players = list(db.players.find({}))
    players_by_name = {}
    players_by_cbid = {}
    for p in players:
        name = p["name"].strip().lower()
        players_by_name[name] = p
        parts = name.split()
        if len(parts) > 1:
            players_by_name[parts[-1]] = p
        if p.get("cricbuzzId"):
            players_by_cbid[p["cricbuzzId"]] = p

    def find_player(name=None, cb_id=None):
        if cb_id and cb_id in players_by_cbid:
            return players_by_cbid[cb_id]
        if not name:
            return None
        clean = name.strip().lower()
        if clean in players_by_name:
            return players_by_name[clean]
        last = clean.split()[-1] if clean else ""
        if last and last in players_by_name:
            return players_by_name[last]
        for key, p in players_by_name.items():
            if last and last in key:
                return p
        return None

    # Process performances
    performances = {}  # player_id_str -> perf dict

    def get_perf(player_id):
        pid = str(player_id)
        if pid not in performances:
            performances[pid] = {
                "playerId": ObjectId(pid), "matchId": match_id,
                "runs": 0, "ballsFaced": 0, "fours": 0, "sixes": 0,
                "isDismissed": False, "didBat": False,
                "oversBowled": 0, "runsConceded": 0, "wickets": 0, "maidens": 0,
                "lbwBowledWickets": 0,
                "catches": 0, "stumpings": 0, "runOutDirect": 0, "runOutIndirect": 0,
            }
        return performances[pid]

    # Build cb_id → player map for fielding lookups
    cb_to_player = {}

    for innings in scorecard["innings"]:
        # ── Batting ──
        for bat in innings["batting"]:
            player = find_player(bat["name"], bat.get("cb_id"))
            if not player:
                continue
            if bat.get("cb_id"):
                cb_to_player[bat["cb_id"]] = player

            perf = get_perf(player["_id"])
            perf["didBat"] = True
            perf["runs"] = bat["runs"]
            perf["ballsFaced"] = bat["balls"]
            perf["fours"] = bat["fours"]
            perf["sixes"] = bat["sixes"]
            perf["isDismissed"] = bat["is_out"]

            # LBW/Bowled bonus
            wc = bat.get("wicket_code", "")
            if wc in ("LBW", "BOWLED") and bat.get("bowler_id"):
                bowler = find_player(cb_id=bat["bowler_id"])
                if not bowler:
                    # Try to find bowler from bowling data
                    for inn2 in scorecard["innings"]:
                        for b in inn2["bowling"]:
                            if b.get("cb_id") == bat["bowler_id"]:
                                bowler = find_player(b["name"], b["cb_id"])
                                break
                if bowler:
                    bp = get_perf(bowler["_id"])
                    bp["lbwBowledWickets"] += 1

            # Fielding: catch
            if wc == "CAUGHT" and bat.get("fielder_id1"):
                fielder = cb_to_player.get(bat["fielder_id1"]) or find_player(cb_id=bat["fielder_id1"])
                if fielder:
                    fp = get_perf(fielder["_id"])
                    fp["catches"] += 1

            # Fielding: stumping
            if wc == "STUMPED" and bat.get("fielder_id1"):
                fielder = cb_to_player.get(bat["fielder_id1"]) or find_player(cb_id=bat["fielder_id1"])
                if fielder:
                    fp = get_perf(fielder["_id"])
                    fp["stumpings"] += 1

            # Fielding: run out
            if wc == "RUNOUT":
                if bat.get("fielder_id1"):
                    fielder = cb_to_player.get(bat["fielder_id1"]) or find_player(cb_id=bat["fielder_id1"])
                    if fielder:
                        fp = get_perf(fielder["_id"])
                        if bat.get("fielder_id2"):
                            fp["runOutIndirect"] += 1
                        else:
                            fp["runOutDirect"] += 1
                if bat.get("fielder_id2"):
                    fielder2 = cb_to_player.get(bat["fielder_id2"]) or find_player(cb_id=bat["fielder_id2"])
                    if fielder2:
                        fp2 = get_perf(fielder2["_id"])
                        fp2["runOutIndirect"] += 1

        # ── Bowling ──
        for bowl in innings["bowling"]:
            player = find_player(bowl["name"], bowl.get("cb_id"))
            if not player:
                continue
            if bowl.get("cb_id"):
                cb_to_player[bowl["cb_id"]] = player

            perf = get_perf(player["_id"])
            perf["oversBowled"] = bowl["overs"]
            perf["runsConceded"] = bowl["runs"]
            perf["wickets"] = bowl["wickets"]
            perf["maidens"] = bowl["maidens"]

    if not performances:
        print(f"    No performances mapped for {match.get('team1')} vs {match.get('team2')}")
        return None

    # Upsert performances + calculate fantasy points
    player_points = {}
    for pid, perf in performances.items():
        player = next((p for p in players if str(p["_id"]) == pid), None)
        role = player.get("role", "batsman") if player else "batsman"
        pts = calculate_fantasy_points(perf, role)
        perf["fantasyPoints"] = pts
        player_points[pid] = pts

        db.playerperformances.update_one(
            {"playerId": perf["playerId"], "matchId": match_id},
            {"$set": perf}, upsert=True
        )

    # Recalculate fantasy teams
    teams_cursor = list(db.fantasyteams.find({"matchId": match_id}))
    team_scores = []
    for team in teams_cursor:
        total = 0.0
        for p_id in team.get("players", []):
            base = player_points.get(str(p_id), 0)
            is_cap = str(team.get("captain")) == str(p_id)
            is_vc = str(team.get("viceCaptain")) == str(p_id)
            total += apply_multiplier(base, is_cap, is_vc)
        total = round(total, 1)
        db.fantasyteams.update_one({"_id": team["_id"]}, {"$set": {"totalPoints": total}})

        user = db.users.find_one({"_id": team["userId"]})
        if user:
            team_scores.append({
                "userId": str(team["userId"]),
                "userName": user.get("name", "?"),
                "phone": user.get("phone", ""),
                "totalPoints": total
            })

    team_scores.sort(key=lambda x: x["totalPoints"], reverse=True)
    print(f"    Updated {len(performances)} players, {len(teams_cursor)} teams")
    return {"match": match, "team_scores": team_scores}


def send_whatsapp_updates(db, match, team_scores, state):
    """Send personalized WhatsApp DM to each league member."""
    match_key = str(match["_id"])
    now = time.time()
    last_sent = state.get("last_dm", {}).get(match_key, 0)

    if now - last_sent < DM_INTERVAL_MIN * 60:
        return

    if not team_scores:
        return

    league = db.leagues.find_one({"season": "IPL_2026"})
    if not league:
        return

    members = list(db.users.find({"_id": {"$in": league.get("members", [])}, "phone": {"$ne": ""}}))
    top5 = team_scores[:5]
    lb_text = "\n".join(f"{i+1}. {u['userName']} \u2014 {u['totalPoints']} pts" for i, u in enumerate(top5))

    is_complete = match.get("status") == "completed"

    for user in members:
        phone = user.get("phone", "")
        if not phone:
            continue

        my_rank = next((i for i, t in enumerate(team_scores) if t["userId"] == str(user["_id"])), -1)
        my_line = f"\nYou're #{my_rank + 1} with {team_scores[my_rank]['totalPoints']} pts" if my_rank >= 0 else ""

        if is_complete:
            medals = ["\U0001f947", "\U0001f948", "\U0001f949"]
            podium = "\n".join(
                f"{medals[i] if i < 3 else f'{i+1}.'} {u['userName']} \u2014 {u['totalPoints']} pts"
                for i, u in enumerate(top5)
            )
            msg = f"\U0001f3c6 *{match['team1']} vs {match['team2']}* \u2014 Match Complete!\n\n{podium}{my_line}\n\nFull leaderboard in the app."
        else:
            msg = f"\U0001f4ca *Live \u2014 {match['team1']} vs {match['team2']}*\n\n{lb_text}{my_line}\n\nPoints updating live!"

        send_dm(phone, msg)

    state.setdefault("last_dm", {})[match_key] = now
    print(f"    Sent DMs to {len(members)} members")


# ─── Main ───
def main():
    now = datetime.now(IST)
    print(f"\n[{now.strftime('%Y-%m-%d %H:%M:%S IST')}] IPL Scraper run")

    state = load_state()

    # 1. Find live IPL matches
    try:
        matches = get_live_ipl_matches()
    except Exception as e:
        print(f"  Error fetching match list: {e}")
        return

    if not matches:
        print("  No live IPL matches")
        return

    print(f"  Found {len(matches)} match(es)")

    # 2. Connect to MongoDB
    client = MongoClient(MONGO_URI)
    db = client["test"]

    try:
        for m in matches:
            cb_id = m["cb_id"]
            print(f"\n  CB#{cb_id}: {m['slug']}")

            try:
                # 3. Extract scorecard JSON from RSC payload
                raw = extract_scorecard_json(cb_id)
                if not raw:
                    print("    No scorecard data in RSC payload")
                    continue

                # 4. Parse into our format
                scorecard = parse_scorecard(raw)
                if not scorecard or not scorecard["innings"]:
                    print("    No innings parsed")
                    continue

                total_bat = sum(len(i["batting"]) for i in scorecard["innings"])
                total_bowl = sum(len(i["bowling"]) for i in scorecard["innings"])
                print(f"    Parsed: {len(scorecard['innings'])} innings, {total_bat} batters, {total_bowl} bowlers")
                print(f"    Teams: {scorecard['teams']}")

                # 5. Update MongoDB + recalculate points
                result = update_match_scores(db, cb_id, scorecard)
                if not result:
                    continue

                # 6. Send WhatsApp DMs
                send_whatsapp_updates(db, result["match"], result["team_scores"], state)

            except Exception as e:
                print(f"    Error: {e}")
                import traceback
                traceback.print_exc()

    finally:
        save_state(state)
        client.close()

    print("\n  Done.")


if __name__ == "__main__":
    main()
