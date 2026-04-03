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
import random
import requests
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient
from bson import ObjectId
from infinity_max_brain import auto_build_and_submit, build_team_summary_message, INFINITY_MAX_USER_ID

# ─── Config ───
import os
from pathlib import Path
# Load .env if exists (never hardcode credentials)
_env_path = Path(__file__).parent / '.env'
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())
MONGO_URI = os.environ.get('MONGO_URI', 'SET_MONGO_URI_IN_ENV')
WA_URL = "https://wa.dotsai.cloud/api/send/text"
WA_MEDIA_URL = "https://wa.dotsai.cloud/api/send/media"
WA_TOKEN = os.environ.get('WA_TOKEN', os.environ.get('WHATSAPP_API_TOKEN', 'SET_WA_TOKEN_IN_ENV'))
APP_BASE_URL = os.environ.get('APP_BASE_URL', 'https://ipl-fantasy-live.vercel.app').rstrip('/')
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
IST = timezone(timedelta(hours=5, minutes=30))
DM_INTERVAL_MIN = 3
STATE_FILE = "/opt/services/ipl-scraper/state.json"

# WhatsApp Group — Saanp Premier League
SPL_GROUP_JID = "120363407548600267@g.us"

# Reminder schedule: 40min, 20min, 10min before deadline
REMINDER_MINS = [40, 20, 10]

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
    if perf.get("didBat") and runs == 0 and perf.get("isDismissed") and role != "BOWL":
        pts -= 2.0
    if bf >= 10:
        sr = (runs / bf) * 100
        if sr > 170: pts += 6.0
        elif sr > 150: pts += 4.0
        elif sr >= 130: pts += 2.0
        elif 60 <= sr <= 70: pts -= 2.0
        elif 50 <= sr < 60: pts -= 4.0
        elif sr < 50: pts -= 6.0

    # Bowling
    pts += wk * 25.0
    pts += perf.get("lbwBowledWickets", 0) * 8.0
    pts += perf.get("maidens", 0) * 12.0
    if wk >= 5: pts += 16.0
    elif wk >= 4: pts += 8.0
    if overs >= 2:
        eco = perf.get("runsConceded", 0) / overs
        if eco < 5: pts += 6.0
        elif eco < 6: pts += 4.0
        elif eco <= 7: pts += 2.0
        elif 10 <= eco <= 11: pts -= 2.0
        elif 11 < eco <= 12: pts -= 4.0
        elif eco > 12: pts -= 6.0

    # Fielding
    pts += perf.get("catches", 0) * 8.0
    if perf.get("catches", 0) >= 3: pts += 4.0
    pts += perf.get("stumpings", 0) * 12.0
    pts += perf.get("runOutDirect", 0) * 12.0
    pts += perf.get("runOutIndirect", 0) * 6.0
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
    """Send personal DM (kept for fallback)."""
    if not phone:
        return False
    try:
        r = requests.post(WA_URL, json={"to": phone, "message": message},
                         headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                         timeout=10)
        return r.ok
    except:
        return False


def send_group(message):
    """Send message to Saanp Premier League group."""
    try:
        r = requests.post(WA_URL, json={"to": SPL_GROUP_JID, "message": message},
                         headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                         timeout=10)
        if r.ok:
            print(f"    Group msg sent ({len(message)} chars)")
        else:
            print(f"    Group msg FAILED: {r.status_code} {r.text[:100]}")
        return r.ok
    except Exception as e:
        print(f"    Group msg error: {e}")
        return False


def send_group_gif(gif_url, caption=""):
    """Send a GIF/image to the group with optional caption. Falls back to text if GIF fails."""
    try:
        # Try as image first (works better with .gif URLs)
        r = requests.post(WA_MEDIA_URL,
                         json={"to": SPL_GROUP_JID, "type": "image", "url": gif_url, "caption": caption},
                         headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                         timeout=15)
        if r.ok:
            print(f"    Group GIF sent")
            return True
        # Retry as video
        r2 = requests.post(WA_MEDIA_URL,
                          json={"to": SPL_GROUP_JID, "type": "video", "url": gif_url, "caption": caption},
                          headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                          timeout=15)
        if r2.ok:
            print(f"    Group GIF sent (as video)")
            return True
        print(f"    Group GIF FAILED: {r.status_code} — falling back to text")
        # Fallback: send as plain text
        send_group(caption)
        return False
    except Exception as e:
        print(f"    Group GIF error: {e} — falling back to text")
        send_group(caption)
        return False


# ─── Media Pool (all verified 200 OK) ───
# Variety is king: GIFs, avatars, memes — random mix keeps group hyped
AVATAR_BASE_URL = "https://dotsai.in/spl-avatars"

GIFS = {
    "celebration": [
        "https://media3.giphy.com/media/1rdLseLhDMiBnumJzM/giphy.gif",
        "https://media4.giphy.com/media/pCJWxPzAbGHHIWHoep/giphy.gif",
        "https://media0.giphy.com/media/E5GdvnFmutdwQhZc22/giphy.gif",
        "https://media3.giphy.com/media/SqoTSUxfRR1PPTXMPv/giphy.gif",
        "https://media0.giphy.com/media/qia2rxxWQ6B01pOf10/giphy.gif",
        "https://media1.giphy.com/media/5wgdVaOwGyWzNxoYKD/giphy.gif",
    ],
    "wicket": [
        "https://media4.giphy.com/media/UMzYGpUkzuwMlT2mXL/giphy.gif",
        "https://media1.giphy.com/media/xW66oX2jHcCpp49uWs/giphy.gif",
        "https://media3.giphy.com/media/THIImhwN2fV2q8EOvq/giphy.gif",
        "https://media2.giphy.com/media/xB68elnmZURlOlOUZ1/giphy.gif",
        "https://media4.giphy.com/media/2CUJFvoRXDrUeG1mOS/giphy.gif",
    ],
    "drama": [
        "https://media1.giphy.com/media/e8K0OMxMIZ5j5AxyiA/giphy.gif",
        "https://media0.giphy.com/media/ItOC6bcYSUE3QdQPwU/giphy.gif",
        "https://media3.giphy.com/media/NvlwExVCntLTqXVg7X/giphy.gif",
        "https://media1.giphy.com/media/evVKsrjZEqVVWvE2VR/giphy.gif",
        "https://media1.giphy.com/media/ksioubEKq0ufcB4z1S/giphy.gif",
    ],
}

# All GIFs in one flat pool for truly random picks
ALL_GIFS = GIFS["celebration"] + GIFS["wicket"] + GIFS["drama"]


def pick_media(category, user_id=None):
    """
    Pick media for a milestone/takeover — returns (url, is_avatar).
    Mix strategy:
      - 40% chance: personalized cartoon avatar (if user_id available)
      - 30% chance: category-specific GIF
      - 30% chance: random GIF from full pool
    This keeps it unpredictable — sometimes avatar, sometimes funny GIF.
    """
    roll = random.random()

    # 40% avatar (only if user_id exists)
    if user_id and roll < 0.4:
        return f"{AVATAR_BASE_URL}/{user_id}.png", True

    # 30% category-specific
    if roll < 0.7:
        pool = GIFS.get(category, ALL_GIFS)
        return random.choice(pool), False

    # 30% any random GIF
    return random.choice(ALL_GIFS), False


def send_milestone_media(msg, category="celebration", user_id=None):
    """Send a milestone message with mixed media — GIF, avatar, or text fallback."""
    url, is_avatar = pick_media(category, user_id)
    send_group_gif(url, msg)


def detect_milestones(db, match, scorecard, state):
    """
    Compare current scorecard with previous state to detect milestones.
    Send hype messages + GIFs for each new milestone.
    """
    match_id = str(match["_id"])
    milestone_key = f"{match_id}_milestones"
    sent_milestones = set(state.get("last_dm", {}).get(milestone_key, []))
    new_milestones = []

    t1 = match.get("team1", "Team 1")
    t2 = match.get("team2", "Team 2")

    # Track innings scores for live scorecard
    innings_summary = []

    for i, innings in enumerate(scorecard.get("innings", [])):
        score_detail = innings.get("score_detail", {})
        runs = score_detail.get("runs", 0)
        wickets = score_detail.get("wickets", 0)
        overs = score_detail.get("overs", 0)
        bat_team = innings.get("bat_team", f"Team {i+1}")
        innings_summary.append(f"{bat_team}: {runs}/{wickets} ({overs} ov)")

        # ── Batting milestones ──
        for bat in innings.get("batting", []):
            player_name = bat.get("name", "?")
            runs_scored = bat.get("runs", 0)
            balls = bat.get("balls", 0)
            sixes = bat.get("sixes", 0)
            fours = bat.get("fours", 0)

            # Half century (50)
            if runs_scored >= 50 and runs_scored < 100:
                key = f"fifty_{player_name}_{i}"
                if key not in sent_milestones:
                    sr = round(runs_scored / balls * 100, 1) if balls > 0 else 0
                    msg = (f"\U0001f4a5 *FIFTY!* {player_name} \U0001f525\n\n"
                           f"{runs_scored} ({balls}) | {fours} fours, {sixes} sixes | SR {sr}\n\n"
                           f"\U0001f4ca {' | '.join(innings_summary)}")
                    send_milestone_media(msg, "celebration")
                    new_milestones.append(key)

            # Century (100)
            if runs_scored >= 100:
                key = f"century_{player_name}_{i}"
                if key not in sent_milestones:
                    sr = round(runs_scored / balls * 100, 1) if balls > 0 else 0
                    msg = (f"\U0001f451 *CENTURY!!!* {player_name} \U0001f680\U0001f680\U0001f680\n\n"
                           f"{runs_scored} ({balls}) | {fours} fours, {sixes} sixes | SR {sr}\n\n"
                           f"WHAT. A. KNOCK. \U0001f525\U0001f525\U0001f525\n\n"
                           f"\U0001f4ca {' | '.join(innings_summary)}")
                    send_milestone_media(msg, "celebration")
                    new_milestones.append(key)

            # 150 (special)
            if runs_scored >= 150:
                key = f"150_{player_name}_{i}"
                if key not in sent_milestones:
                    msg = (f"\U0001f92f *150 UP!* {player_name} is UNSTOPPABLE!\n\n"
                           f"{runs_scored} ({balls}) | {fours}x4, {sixes}x6\n\n"
                           f"This is MADNESS \U0001f525\U0001f525\U0001f525")
                    send_milestone_media(msg, "celebration")
                    new_milestones.append(key)

        # ── Bowling milestones ──
        for bowl in innings.get("bowling", []):
            bowler_name = bowl.get("name", "?")
            wk = bowl.get("wickets", 0)
            bowl_overs = bowl.get("overs", 0)
            econ = bowl.get("economy", 0)
            bowl_runs = bowl.get("runs", 0)

            # 3 wickets
            if wk >= 3 and wk < 5:
                key = f"3wkt_{bowler_name}_{i}"
                if key not in sent_milestones:
                    msg = (f"\U0001f3af *{wk} WICKETS!* {bowler_name} is on fire!\n\n"
                           f"{wk}/{bowl_runs} ({bowl_overs} ov) | Econ {econ}\n\n"
                           f"\U0001f4ca {' | '.join(innings_summary)}")
                    send_milestone_media(msg, "wicket")
                    new_milestones.append(key)

            # 5-wicket haul (FIFER!)
            if wk >= 5:
                key = f"fifer_{bowler_name}_{i}"
                if key not in sent_milestones:
                    msg = (f"\U0001f525\U0001f525\U0001f525 *5-WICKET HAUL!* {bowler_name}\n\n"
                           f"{wk}/{bowl_runs} ({bowl_overs} ov) | Econ {econ}\n\n"
                           f"ABSOLUTE DESTRUCTION! \U0001f4a3\n\n"
                           f"\U0001f4ca {' | '.join(innings_summary)}")
                    send_milestone_media(msg, "wicket")
                    new_milestones.append(key)

            # Maiden over
            if bowl.get("maidens", 0) > 0:
                maiden_count = bowl.get("maidens", 0)
                key = f"maiden_{bowler_name}_{i}_{maiden_count}"
                if key not in sent_milestones:
                    msg = (f"\U0001f6e1\ufe0f *MAIDEN OVER!* {bowler_name}\n\n"
                           f"Dot dot dot dot dot dot! \U0001f525 Economy: {econ}")
                    send_milestone_media(msg, "wicket")
                    new_milestones.append(key)

        # ── Team score milestones ──
        for target in [50, 100, 150, 200, 250, 300]:
            if runs >= target:
                key = f"team_{target}_{bat_team}_{i}"
                if key not in sent_milestones:
                    msg = (f"\U0001f4ca *{target} UP!* {bat_team} — {runs}/{wickets} ({overs} ov)\n\n"
                           f"{'Run rate: ' + str(round(runs / overs, 2)) + ' RPO' if overs > 0 else ''}")
                    send_milestone_media(msg, "celebration")
                    new_milestones.append(key)

        # ── Wicket alerts (new dismissals) ──
        for bat in innings.get("batting", []):
            if bat.get("is_out", False):
                player_name = bat.get("name", "?")
                runs_scored = bat.get("runs", 0)
                balls = bat.get("balls", 0)
                out_desc = bat.get("out_desc", "")
                key = f"out_{player_name}_{i}"
                if key not in sent_milestones:
                    # Only alert for batsmen who scored 20+ (meaningful wicket)
                    if runs_scored >= 20:
                        msg = (f"\u274c *WICKET!* {player_name} — {runs_scored} ({balls})\n"
                               f"{out_desc}\n\n"
                               f"\U0001f4ca {' | '.join(innings_summary)}")
                        send_milestone_media(msg, "wicket")
                        new_milestones.append(key)
                    elif runs_scored < 5:
                        # Cheap dismissal — drama!
                        msg = (f"\U0001f480 *OUT!* {player_name} gone for {runs_scored} ({balls})\n"
                               f"{out_desc}\n\n"
                               f"\U0001f4ca {' | '.join(innings_summary)}")
                        send_milestone_media(msg, "drama")
                        new_milestones.append(key)

    # ── Innings break ──
    if len(scorecard.get("innings", [])) == 2:
        first_inn = scorecard["innings"][0]
        first_score = first_inn.get("score_detail", {})
        if first_score.get("wickets", 0) == 10 or float(first_score.get("overs", 0)) >= 20:
            key = f"innings_break_{match_id}"
            if key not in sent_milestones:
                bat_team = first_inn.get("bat_team", "?")
                target = first_score.get("runs", 0) + 1
                msg = (f"\U0001f3cf *INNINGS BREAK!*\n\n"
                       f"{bat_team}: {first_score.get('runs', 0)}/{first_score.get('wickets', 0)} "
                       f"({first_score.get('overs', 0)} ov)\n\n"
                       f"\U0001f3af *Target: {target}*\n\n"
                       f"Second innings coming up! \U0001f525")
                send_milestone_media(msg, "drama")
                new_milestones.append(key)

    # Save milestones to state
    if new_milestones:
        all_sent = list(sent_milestones) + new_milestones
        state.setdefault("last_dm", {})[milestone_key] = all_sent
        print(f"    Milestones fired: {len(new_milestones)} ({', '.join(new_milestones)})")

    # Return innings summary for live scorecard
    return innings_summary


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

        # Score details for this innings
        score_details = innings.get("scoreDetails", {})
        inn = {
            "team": team_name,
            "bat_team": team_name,
            "score_detail": {
                "runs": score_details.get("runs", 0),
                "wickets": score_details.get("wickets", 0),
                "overs": score_details.get("overs", 0),
            },
            "batting": [],
            "bowling": [],
        }

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

    # Auto-populate playingXI from scorecard data if not already set
    existing_xi = match.get("playingXI", {})
    if not existing_xi.get("team1") or not existing_xi.get("team2"):
        # Collect player IDs by franchise, matched to team1/team2
        t1_abbr = match.get("team1", "")
        t2_abbr = match.get("team2", "")
        xi_team1 = set()
        xi_team2 = set()
        for pid in performances:
            player = next((p for p in players if str(p["_id"]) == pid), None)
            if not player:
                continue
            franchise = player.get("franchise", "")
            if franchise == t1_abbr:
                xi_team1.add(player["_id"])
            elif franchise == t2_abbr:
                xi_team2.add(player["_id"])

        # Only set if we found at least 11 players per side (full XI)
        if len(xi_team1) >= 11 or len(xi_team2) >= 11:
            update_xi = {}
            if len(xi_team1) >= 11 and not existing_xi.get("team1"):
                update_xi["playingXI.team1"] = list(xi_team1)[:11]
            if len(xi_team2) >= 11 and not existing_xi.get("team2"):
                update_xi["playingXI.team2"] = list(xi_team2)[:11]
            if update_xi:
                db.matches.update_one({"_id": match_id}, {"$set": update_xi})
                print(f"    Auto-set playingXI: team1={len(xi_team1)}, team2={len(xi_team2)}")

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
    league = db.leagues.find_one({"season": "IPL_2026"}, {"members": 1})
    member_id_set = {str(uid) for uid in league.get("members", [])} if league else set()
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
        if user and (not member_id_set or str(team["userId"]) in member_id_set):
            team_scores.append({
                "userId": str(team["userId"]),
                "userName": user.get("name", "?"),
                "phone": user.get("phone", ""),
                "totalPoints": total
            })

    team_scores.sort(key=lambda x: x["totalPoints"], reverse=True)
    print(f"    Updated {len(performances)} players, {len(teams_cursor)} teams")
    return {"match": match, "team_scores": team_scores}


def detect_takeovers(db, match, team_scores, state):
    """
    Compare current leaderboard with previous snapshot.
    When someone overtakes another, post analysis of what caused the swing.
    """
    match_key = str(match["_id"])
    rankings_key = f"{match_key}_prev_rankings"

    if not team_scores or len(team_scores) < 2:
        return

    # Build current ranking: {userName: {rank, points, userId}}
    current = {}
    for i, ts in enumerate(team_scores):
        current[ts["userName"]] = {"rank": i + 1, "points": ts["totalPoints"], "userId": ts.get("userId", "")}

    # Load previous ranking from state
    prev = state.get("last_dm", {}).get(rankings_key, {})

    takeovers = []
    if prev:
        for name, cur_info in current.items():
            prev_info = prev.get(name)
            if not prev_info:
                continue
            cur_rank = cur_info["rank"]
            prev_rank = prev_info["rank"]
            cur_pts = cur_info["points"]
            prev_pts = prev_info["points"]
            points_gained = cur_pts - prev_pts

            # Someone moved up at least 1 position AND gained points
            if cur_rank < prev_rank and points_gained > 0:
                # Find who they overtook
                overtaken = []
                for other_name, other_cur in current.items():
                    if other_name == name:
                        continue
                    other_prev = prev.get(other_name, {})
                    if not other_prev:
                        continue
                    # This person was above 'name' before but is now below
                    if other_prev.get("rank", 99) < prev_rank and other_cur["rank"] > cur_rank:
                        overtaken.append(other_name)

                if overtaken:
                    takeovers.append({
                        "name": name,
                        "userId": cur_info.get("userId", ""),
                        "prev_rank": prev_rank,
                        "cur_rank": cur_rank,
                        "points_gained": points_gained,
                        "cur_points": cur_pts,
                        "overtaken": overtaken,
                    })

    # Send takeover messages (max 2 per cycle to avoid spam)
    takeover_dedup_key = f"{match_key}_takeovers_sent"
    sent_takeovers = set(state.get("last_dm", {}).get(takeover_dedup_key, []))

    for to in takeovers[:2]:
        dedup = f"{to['name']}_rank{to['cur_rank']}"
        if dedup in sent_takeovers:
            continue

        overtaken_names = ", ".join(to["overtaken"])
        arrow = f"#{to['prev_rank']} \u27a1\ufe0f #{to['cur_rank']}"

        # Build the reason — check what player events caused the swing
        reason_parts = []
        # Check recent milestones that could explain it
        ms_key = f"{match_key}_milestones"
        recent_ms = state.get("last_dm", {}).get(ms_key, [])
        for ms in recent_ms[-5:]:  # last 5 milestones
            if "fifty" in ms or "century" in ms:
                player = ms.split("_")[1] if "_" in ms else ""
                reason_parts.append(f"{player}'s batting surge")
            elif "out_" in ms:
                player = ms.replace("out_", "").rsplit("_", 1)[0]
                reason_parts.append(f"{player}'s wicket")
            elif "3wkt" in ms or "fifer" in ms:
                player = ms.split("_")[1] if "_" in ms else ""
                reason_parts.append(f"{player}'s bowling spell")

        reason = ""
        if reason_parts:
            unique_reasons = list(dict.fromkeys(reason_parts))[:3]
            reason = f"\n\U0001f4a1 Key events: {', '.join(unique_reasons)}"

        msg = (f"\U0001f4c8 *TAKEOVER!* {to['name']} jumps to #{to['cur_rank']}! {arrow}\n\n"
               f"\U0001f4aa +{to['points_gained']:.0f} pts \u2192 {to['cur_points']:.0f} total\n"
               f"\U0001f6a8 Overtook: {overtaken_names}"
               f"{reason}\n\n"
               f"\U0001f525 The race is ON!")

        # Tiered media based on rank reached:
        #   1st-2nd: solid celebration GIF
        #   3rd: normal random GIF
        #   4th-5th: cartoon avatar
        #   6th+: just text, no media
        rank = to["cur_rank"]
        if rank <= 2:
            send_group_gif(random.choice(GIFS["celebration"]), msg)
        elif rank == 3:
            send_group_gif(random.choice(ALL_GIFS), msg)
        elif rank <= 5:
            uid = to.get("userId", "")
            if uid:
                send_group_gif(f"{AVATAR_BASE_URL}/{uid}.png", msg)
            else:
                send_group(msg)
        else:
            send_group(msg)
        sent_takeovers.add(dedup)
        print(f"    Takeover: {to['name']} #{to['prev_rank']}->{to['cur_rank']} (overtook {overtaken_names})")

    # Save current rankings as previous for next run
    state.setdefault("last_dm", {})[rankings_key] = current
    if sent_takeovers:
        state["last_dm"][takeover_dedup_key] = list(sent_takeovers)


def send_whatsapp_updates(db, match, team_scores, state):
    """Send live/completion updates to group instead of individual DMs."""
    match_key = str(match["_id"])
    now = time.time()
    last_sent = state.get("last_dm", {}).get(match_key, 0)

    # Skip if sent recently (15 min throttle)
    if now - last_sent < DM_INTERVAL_MIN * 60:
        return

    if not team_scores:
        return

    # Skip if final message already sent for this match
    final_key = f"{match_key}_final"
    if state.get("last_dm", {}).get(final_key):
        return

    is_complete = match.get("status") == "completed"
    all_scores = team_scores  # already sorted desc
    top = all_scores[:15]

    if is_complete:
        medals = ["\U0001f947", "\U0001f948", "\U0001f949"]
        podium = "\n".join(
            f"{medals[i] if i < 3 else f'{i+1}.'} {u['userName']} — {u['totalPoints']} pts"
            for i, u in enumerate(all_scores)
        )
        msg = (f"\U0001f3c6 *{match['team1']} vs {match['team2']}* — Match Complete!\n\n"
               f"{podium}\n\n"
               f"\U0001f4b0 Winner takes ₹{len(all_scores) * 60} pot!\n"
               f"Full breakdown in the app \U0001f449 {APP_BASE_URL}")
        send_group(msg)
        # Mark as final so we never message again for this match
        state.setdefault("last_dm", {})[final_key] = True
    else:
        lb_text = "\n".join(
            f"{i+1}. {u['userName']} — {u['totalPoints']} pts"
            for i, u in enumerate(top)
        )
        msg = (f"\U0001f4ca *Live — {match['team1']} vs {match['team2']}*\n\n"
               f"*Top 15 right now:*\n{lb_text}\n\n"
               f"Points updating every 3 min! \U0001f525")
        send_group(msg)

    state.setdefault("last_dm", {})[match_key] = now
    print(f"    Sent group update ({'final' if is_complete else 'live'})")


def send_submission_reminders(db, state):
    """
    Send 3 reminders to group before each match deadline:
    40 min, 20 min, 10 min — showing who submitted vs who is pending.
    """
    now_ist = datetime.now(IST)
    now_utc = datetime.utcnow()  # naive UTC for MongoDB queries
    league = db.leagues.find_one({"season": "IPL_2026"})
    if not league:
        return

    member_ids = league.get("members", [])
    members = list(db.users.find({"_id": {"$in": member_ids}}))

    # Find upcoming matches (deadline in next 45 min)
    # MongoDB stores deadline as naive UTC, so query with naive UTC
    upcoming = list(db.matches.find({
        "status": "upcoming",
        "deadline": {"$gt": now_utc, "$lt": now_utc + timedelta(minutes=45)}
    }))

    for match in upcoming:
        match_key = str(match["_id"])
        deadline = match.get("deadline")
        if not deadline:
            continue

        # Make deadline timezone-aware — MongoDB stores as naive UTC
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc).astimezone(IST)

        mins_left = (deadline - now_ist).total_seconds() / 60

        # Check which reminder tier we're in
        for tier_min in REMINDER_MINS:
            tier_key = f"{match_key}_reminder_{tier_min}"

            # Already sent this tier?
            if state.get("last_dm", {}).get(tier_key):
                continue

            # Is it time for this tier? (within 3 min window since cron runs every 3 min)
            if mins_left <= tier_min and mins_left > tier_min - 4:
                # Find who submitted and who didn't
                submitted_teams = list(db.fantasyteams.find({"matchId": match["_id"]}))
                submitted_user_ids = {str(t["userId"]) for t in submitted_teams}

                submitted = []
                pending = []
                for m in members:
                    name = m.get("name", "?")
                    if str(m["_id"]) in submitted_user_ids:
                        submitted.append(name)
                    else:
                        pending.append(name)

                submitted_text = ", ".join(submitted) if submitted else "Nobody yet!"
                pending_text = ", ".join(pending) if pending else "All done! \U0001f389"

                urgency = {40: "\u23f0", 20: "\u26a0\ufe0f", 10: "\U0001f6a8"}
                mins_display = round(mins_left)

                reminder_emoji = urgency.get(tier_min, "⏰")
                msg = (f"{reminder_emoji} *{match['team1']} vs {match['team2']}* — "
                       f"*{mins_display} min* to deadline!\n\n"
                       f"\u2705 *Submitted:* {submitted_text}\n"
                       f"\u274c *Pending:* {pending_text}\n\n"
                       f"Lock your team now! \U0001f449 {APP_BASE_URL}")

                send_group(msg)
                state.setdefault("last_dm", {})[tier_key] = True
                print(f"    Reminder sent: {tier_min}min tier for {match['team1']} vs {match['team2']}")
                break  # Only send one tier per run


# ─── Randomizer: auto-pick teams for users who missed deadline ───
def generate_random_team(players_pool):
    """
    Pick 11 valid players from a pool (playing 22).
    Constraints: ≤100 credits, min 1 WK, min 2 BAT, min 2 AR, min 2 BOWL, max 7 per franchise.
    No upper bound per role — fill remaining spots freely after minimums are met.
    Returns (players_11, captain, vice_captain) or None if impossible.
    """
    BUDGET = 100
    MAX_FRANCHISE = 7

    # Role lower bounds only — no upper cap, fill freely after minimums
    ROLE_MIN = {"WK": 1, "BAT": 2, "AR": 2, "BOWL": 2}

    by_role = {}
    for p in players_pool:
        r = p.get("role", "BAT")
        by_role.setdefault(r, []).append(p)

    # Try up to 200 shuffled attempts
    for _ in range(200):
        team = []
        credits_used = 0
        role_counts = {"WK": 0, "BAT": 0, "AR": 0, "BOWL": 0}
        franchise_counts = {}

        # First pass: pick minimums per role
        pool_copy = {r: list(ps) for r, ps in by_role.items()}
        for r, ps in pool_copy.items():
            random.shuffle(ps)

        picked_ids = set()
        for role, mn in ROLE_MIN.items():
            available = pool_copy.get(role, [])
            for p in available:
                if len(team) >= 11:
                    break
                if role_counts.get(role, 0) >= mn:
                    break
                pid = str(p["_id"])
                if pid in picked_ids:
                    continue
                fr = p.get("franchise", "")
                if franchise_counts.get(fr, 0) >= MAX_FRANCHISE:
                    continue
                if credits_used + p.get("credits", 8) > BUDGET:
                    continue
                team.append(p)
                picked_ids.add(pid)
                credits_used += p.get("credits", 8)
                role_counts[role] += 1
                franchise_counts[fr] = franchise_counts.get(fr, 0) + 1

        # Second pass: fill remaining spots from shuffled pool
        all_remaining = [p for p in players_pool if str(p["_id"]) not in picked_ids]
        random.shuffle(all_remaining)
        for p in all_remaining:
            if len(team) >= 11:
                break
            role = p.get("role", "BAT")
            fr = p.get("franchise", "")
            if franchise_counts.get(fr, 0) >= MAX_FRANCHISE:
                continue
            if credits_used + p.get("credits", 8) > BUDGET:
                continue
            team.append(p)
            picked_ids.add(str(p["_id"]))
            credits_used += p.get("credits", 8)
            role_counts[role] = role_counts.get(role, 0) + 1
            franchise_counts[fr] = franchise_counts.get(fr, 0) + 1

        if len(team) != 11:
            continue

        # Validate minimums are all met
        if any(role_counts.get(role, 0) < mn for role, mn in ROLE_MIN.items()):
            continue

        # Pick captain and vice-captain
        random.shuffle(team)
        captain = team[0]
        vice_captain = team[1]
        return team, captain, vice_captain

    return None


def auto_generate_missing_teams(db, match):
    """
    For a match that has playingXI set, generate random teams for
    league members who haven't submitted.
    """
    match_id = match["_id"]
    playing_xi = match.get("playingXI", {})
    team1_ids = playing_xi.get("team1", [])
    team2_ids = playing_xi.get("team2", [])

    if not team1_ids or not team2_ids:
        return []

    # Get player docs for the playing 22
    all_player_ids = list(team1_ids) + list(team2_ids)
    players_pool = list(db.players.find({"_id": {"$in": all_player_ids}, "isActive": True}))

    if len(players_pool) < 11:
        print(f"    Randomizer: only {len(players_pool)} players in playing XI, need 11. Skipping.")
        return []

    # Get league members
    league = db.leagues.find_one({"season": "IPL_2026"})
    if not league:
        return []
    member_ids = league.get("members", [])

    # Find who already submitted
    existing = db.fantasyteams.find({"matchId": match_id})
    submitted_ids = {str(t["userId"]) for t in existing}

    # Generate for missing members
    auto_picked = []
    for uid in member_ids:
        if str(uid) in submitted_ids:
            continue

        result = generate_random_team(players_pool)
        if not result:
            print(f"    Randomizer: could not generate valid team for user {uid}")
            continue

        team, captain, vice_captain = result
        doc = {
            "userId": uid,
            "matchId": match_id,
            "players": [p["_id"] for p in team],
            "captain": captain["_id"],
            "viceCaptain": vice_captain["_id"],
            "totalPoints": 0,
            "isLocked": False,
            "isAutoGenerated": True,
            "createdAt": datetime.utcnow(),
            "updatedAt": datetime.utcnow(),
        }
        try:
            db.fantasyteams.insert_one(doc)
            user = db.users.find_one({"_id": uid})
            name = user.get("name", "?") if user else "?"
            auto_picked.append(name)
            print(f"    Randomizer: auto-picked team for {name}")
        except Exception as e:
            # Duplicate key = already has a team (race condition)
            print(f"    Randomizer: skip {uid} — {e}")

    if auto_picked:
        names = ", ".join(auto_picked)
        send_group(
            f"\U0001f3b2 *Auto-picked teams* for: {names}\n\n"
            f"Missed the deadline — random team from playing XI assigned!"
        )

    return auto_picked

def update_playing_11_best_effort_basis(match: dict, db) -> bool:
    """
    Best-effort: fetch Playing XI from Cricbuzz and write player ObjectIds into
    the match document's ``playingXI.team1`` / ``playingXI.team2`` fields.

    Steps:
      1. Skip if playingXI already fully populated (both teams have ≥ 11 entries).
      2. Call FetchActualPlaying11.fetch(team1, team2) to get player name lists.
      3. Resolve each name to a Player ObjectId via the ``players`` collection.
      4. Update the *existing* match document in-place (never inserts).

    Returns True if the match was updated, False otherwise.
    """
    match_id  = match["_id"]
    team1_abbr = match.get("team1", "")
    team2_abbr = match.get("team2", "")
    cb_match_id = str(match.get("cricApiMatchId", "") or "")

    existing_xi = match.get("playingXI", {})
    team1_ids   = existing_xi.get("team1", [])
    team2_ids   = existing_xi.get("team2", [])

    # 1. Skip if already fully populated
    if len(team1_ids) >= 11 and len(team2_ids) >= 11:
        print(f"    PlayingXI already set for {team1_abbr} vs {team2_abbr}. Skipping.")
        return False

    # 2. Fetch player names from Cricbuzz
    try:
        from fetch_playing_11 import FetchActualPlaying11
        fetcher = FetchActualPlaying11()
        # Use the Cricbuzz match ID when we have it. The Mongo _id is useless here.
        xi_names = fetcher.fetch(team1_abbr, team2_abbr, cb_match_id)
        # xi_names = {"team1": ["Player A", ...], "team2": ["Player B", ...]}
    except Exception as e:
        print(f"    PlayingXI fetch error for {team1_abbr} vs {team2_abbr}: {e}")
        return False

    t1_names = xi_names.get("team1", []) or xi_names.get(team1_abbr, [])
    t2_names = xi_names.get("team2", []) or xi_names.get(team2_abbr, [])

    if not t1_names or not t2_names:
        print(f"PlayingXI not yet announced for both teams ({team1_abbr} vs {team2_abbr}). Skipping update.")
        return False

    # 3. Resolve player names → ObjectIds via players collection.
    #    Normalise both sides: lowercase + strip all spaces before comparing.
    #    ObjectIds stored in DB remain untouched.
    def _norm(s: str) -> str:
        return s.lower().replace(" ", "")

    # Build lookup once for both teams (fetch only the two franchises involved)
    all_players = list(db.players.find(
        {"franchise": {"$in": [team1_abbr, team2_abbr]}},
        {"_id": 1, "name": 1}
    ))
    player_lookup: dict[str, object] = {_norm(p["name"]): p["_id"] for p in all_players}

    def resolve_player_ids(names: list[str]) -> list:
        if not names:
            return []
        ids = []
        for name in names:
            key = _norm(name)
            player_id = player_lookup.get(key)
            if player_id is not None:
                ids.append(player_id)
            else:
                print(f"Warning: could not resolve player '{name}' to DB entry")
        return ids

    t1_ids = resolve_player_ids(t1_names)
    t2_ids = resolve_player_ids(t2_names)

    # Only update DB when we have resolved IDs for BOTH teams
    if not t1_ids or not t2_ids:
        print(
            f"PlayingXI: could not resolve players for both teams "
            f"({team1_abbr}: {len(t1_ids)}, {team2_abbr}: {len(t2_ids)}). Skipping update."
        )
        return False

    # 4. Update the existing match document in-place (never upsert)
    result = db.matches.update_one(
        {"_id": match_id},
        {"$set": {"playingXI.team1": t1_ids, "playingXI.team2": t2_ids}},
    )

    if result.matched_count == 0:
        print(f"PlayingXI update: match {match_id} not found in DB.")
        return False

    print(
        f"PlayingXI updated for {team1_abbr} vs {team2_abbr}: "
        f"{len(t1_ids)} {team1_abbr} players, {len(t2_ids)} {team2_abbr} players."
    )
    return True



# ─── Squad Announced: notify who needs to edit their team ───
def send_squad_announcement(db, match, state):
    """
    When playingXI gets populated for a match, send a WhatsApp message to the group:
    1. Full playing XI for both teams
    2. For each user who already submitted: which players are NOT in the playing XI
    """
    match_id = match["_id"]
    squad_key = f"{match_id}_squad_announced"

    # Already sent?
    if state.get("last_dm", {}).get(squad_key):
        return

    playing_xi = match.get("playingXI", {})
    team1_ids = [str(pid) for pid in playing_xi.get("team1", [])]
    team2_ids = [str(pid) for pid in playing_xi.get("team2", [])]

    if not team1_ids or not team2_ids:
        return

    all_playing_ids = set(team1_ids + team2_ids)

    # Get player names for playing XI
    team1_players = list(db.players.find({"_id": {"$in": [ObjectId(pid) for pid in team1_ids]}}))
    team2_players = list(db.players.find({"_id": {"$in": [ObjectId(pid) for pid in team2_ids]}}))

    t1_name = match.get("team1", "Team 1")
    t2_name = match.get("team2", "Team 2")

    t1_names = ", ".join(p["name"] for p in team1_players)
    t2_names = ", ".join(p["name"] for p in team2_players)

    # Build the message
    msg_parts = [
        f"\U0001f4cb *Playing XI Announced!*\n",
        f"\U0001f7e0 *{t1_name}:*\n{t1_names}\n",
        f"\U0001f535 *{t2_name}:*\n{t2_names}\n",
    ]

    # Check submitted teams for non-playing players
    league = db.leagues.find_one({"season": "IPL_2026"})
    if league:
        member_ids = league.get("members", [])
        submitted_teams = list(db.fantasyteams.find({"matchId": match_id, "userId": {"$in": member_ids}}))

        edit_alerts = []
        for team in submitted_teams:
            user = db.users.find_one({"_id": team["userId"]})
            if not user:
                continue
            user_name = user.get("name", "?")
            team_player_ids = [str(pid) for pid in team.get("players", [])]
            not_playing = []

            for pid in team_player_ids:
                if pid not in all_playing_ids:
                    player = db.players.find_one({"_id": ObjectId(pid)})
                    if player:
                        not_playing.append(player["name"])

            if not_playing:
                names_str = ", ".join(not_playing)
                edit_alerts.append(f"\u26a0\ufe0f *{user_name}*: Replace {names_str}")

        if edit_alerts:
            msg_parts.append("\u2757 *Edit your team — these players are NOT playing:*\n")
            msg_parts.extend(edit_alerts)
            msg_parts.append(f"\n\U0001f449 {APP_BASE_URL}/")
        else:
            msg_parts.append("\u2705 All submitted teams have only playing XI players!")

    msg = "\n".join(msg_parts)
    send_group(msg)
    state.setdefault("last_dm", {})[squad_key] = True
    print(f"    Squad announcement sent for {t1_name} vs {t2_name}")


# ─── Main ───
def main():
    now = datetime.now(IST)
    print(f"\n[{now.strftime('%Y-%m-%d %H:%M:%S IST')}] IPL Scraper run")

    state = load_state()

    # 1. Connect to MongoDB (needed for both reminders and scoring)
    client = MongoClient(MONGO_URI)
    db = client["test"]

    try:
        # 2. Send submission reminders (runs even without live matches)
        try:
            send_submission_reminders(db, state)
        except Exception as e:
            print(f"  Reminder error: {e}")

        # 3. Find live IPL matches
        try:
            matches = get_live_ipl_matches()
        except Exception as e:
            print(f"  Error fetching match list: {e}")
            matches = []

        if not matches:
            print("  No live IPL matches")
        else:
            print(f"  Found {len(matches)} match(es)")

        # 3b. Best-effort: fetch & store Playing XI for upcoming/toss_done matches
        try:
            pending_xi_matches = list(db.matches.find({
                "status": {"$in": ["upcoming", "toss_done"]},
                "$or": [
                    {"playingXI.team1": {"$exists": False}},
                    {"playingXI.team1": []},
                    {"playingXI.team2": {"$exists": False}},
                    {"playingXI.team2": []},
                ],
            }))
            for pm in pending_xi_matches:
                update_playing_11_best_effort_basis(pm, db)

        except Exception as e:
            print(f"PlayingXI update error: {e}")

        # 3-pre. Infinity Max early submission — upcoming matches with playingXI and deadline < 60min
        try:
            now_utc = datetime.utcnow()
            upcoming_with_xi = list(db.matches.find({
                "status": {"$in": ["upcoming", "toss_done"]},
                "deadline": {"$gt": now_utc, "$lt": now_utc + timedelta(minutes=60)},
                "playingXI.team1": {"$exists": True, "$ne": []},
                "playingXI.team2": {"$exists": True, "$ne": []},
            }))
            for um in upcoming_with_xi:
                try:
                    im_result = auto_build_and_submit(db, um, state)
                    if im_result:
                        im_msg = build_team_summary_message(im_result, um)
                        if im_msg:
                            send_group(im_msg)
                except Exception as im_err:
                    print(f"  Infinity Max early-submit error: {im_err}")
        except Exception as e:
            print(f"  Infinity Max early-submit scan error: {e}")

        # 3a. For matches with playingXI: send squad announcement + auto-generate missing teams
        try:
            live_matches = list(db.matches.find({
                "status": {"$in": ["live", "toss_done"]},
                "playingXI.team1": {"$exists": True, "$ne": []},
                "playingXI.team2": {"$exists": True, "$ne": []},
            }))
            for lm in live_matches:
                # 3a-i. Send squad announcement (once per match)
                try:
                    send_squad_announcement(db, lm, state)
                except Exception as e:
                    print(f"  Squad announcement error: {e}")

                # 3a-ii. Infinity Max smart team builder (runs BEFORE randomizer)
                try:
                    im_result = auto_build_and_submit(db, lm, state)
                    if im_result:
                        im_msg = build_team_summary_message(im_result, lm)
                        if im_msg:
                            send_group(im_msg)
                except Exception as im_err:
                    print(f"  Infinity Max builder error: {im_err}")

                # 3a-iii. Auto-generate teams for users who missed deadline
                rando_key = f"{lm['_id']}_randomized"
                if state.get("last_dm", {}).get(rando_key):
                    continue
                auto_picked = auto_generate_missing_teams(db, lm)
                if auto_picked is not None:
                    # Mark as done even if 0 picks (so we don't retry)
                    state.setdefault("last_dm", {})[rando_key] = True
        except Exception as e:
            print(f"  Randomizer error: {e}")


        for m in matches:
            cb_id = m["cb_id"]
            print(f"\n  CB#{cb_id}: {m['slug']}")

            # Skip completed matches with final msg already sent
            final_key = None
            db_match = db.matches.find_one({"cricApiMatchId": str(cb_id)})
            if db_match:
                final_key = f"{db_match['_id']}_final"
                if state.get("last_dm", {}).get(final_key):
                    print("    Skipped (final msg already sent)")
                    continue

            try:
                # 4. Extract scorecard JSON from RSC payload
                raw = extract_scorecard_json(cb_id)
                if not raw:
                    print("    No scorecard data in RSC payload")
                    continue

                # 5. Parse into our format
                scorecard = parse_scorecard(raw)
                if not scorecard or not scorecard["innings"]:
                    print("    No innings parsed")
                    continue

                total_bat = sum(len(i["batting"]) for i in scorecard["innings"])
                total_bowl = sum(len(i["bowling"]) for i in scorecard["innings"])
                print(f"    Parsed: {len(scorecard['innings'])} innings, {total_bat} batters, {total_bowl} bowlers")
                print(f"    Teams: {scorecard['teams']}")

                # 6. Detect milestones and send hype messages
                db_match_for_ms = db.matches.find_one({"cricApiMatchId": str(cb_id)})
                if db_match_for_ms:
                    try:
                        detect_milestones(db, db_match_for_ms, scorecard, state)
                    except Exception as ms_err:
                        print(f"    Milestone detection error: {ms_err}")

                # 7. Update MongoDB + recalculate points
                result = update_match_scores(db, cb_id, scorecard)
                if not result:
                    continue

                # 8. Detect leaderboard takeovers
                try:
                    detect_takeovers(db, result["match"], result["team_scores"], state)
                except Exception as tk_err:
                    print(f"    Takeover detection error: {tk_err}")

                # 9. Send group updates (live leaderboard)
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
