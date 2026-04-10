#!/usr/bin/env python3
"""
Infinity Max Live Analyst — WhatsApp Message Listener

Polls the SPL group for new messages every 15 seconds.
When a question is detected (mentions Infinity Max, asks about teams/scores/predictions),
queries MongoDB for real stats and replies with data-backed analysis.

Deploy: python3 infinity_max_listener.py (runs as daemon on VPS)
"""
import os
import re
import time
import json
import requests
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient
from bson import ObjectId
from pathlib import Path

# ─── Config ───
_env_path = Path(__file__).parent / '.env'
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

MONGO_URI = os.environ.get('MONGO_URI', '')
WA_URL = "https://wa.dotsai.cloud/api/send/text"
WA_MSG_URL = "https://wa.dotsai.cloud/api/messages"
WA_TOKEN = os.environ.get('WA_TOKEN', os.environ.get('WHATSAPP_API_TOKEN', ''))
SPL_GROUP_JID = "120363407548600267@g.us"
INFINITY_MAX_USER_ID = "69ce725ba581ac3cd041b056"
IST = timezone(timedelta(hours=5, minutes=30))
POLL_INTERVAL = 15  # seconds

# ─── Scoring (mirrors scoring.service.js) ───
def calculate_fantasy_points(perf, role):
    pts = 0.0
    runs = perf.get("runs", 0)
    bf = perf.get("ballsFaced", 0)
    wk = perf.get("wickets", 0)
    overs = perf.get("oversBowled", 0)
    pts += runs
    pts += perf.get("fours", 0)
    pts += perf.get("sixes", 0) * 2
    if runs >= 100: pts += 16
    elif runs >= 50: pts += 8
    if perf.get("didBat") and runs == 0 and perf.get("isDismissed") and role != "BOWL":
        pts -= 2
    if bf >= 10:
        sr = (runs / bf) * 100
        if sr > 170: pts += 6
        elif sr > 150: pts += 4
        elif sr >= 130: pts += 2
        elif 60 <= sr <= 70: pts -= 2
        elif 50 <= sr < 60: pts -= 4
        elif sr < 50: pts -= 6
    pts += wk * 25
    pts += perf.get("lbwBowledWickets", 0) * 8
    pts += perf.get("maidens", 0) * 12
    if wk >= 5: pts += 16
    elif wk >= 4: pts += 8
    if overs >= 2:
        eco = perf.get("runsConceded", 0) / overs
        if eco < 5: pts += 6
        elif eco < 6: pts += 4
        elif eco <= 7: pts += 2
        elif 10 <= eco <= 11: pts -= 2
        elif 11 < eco <= 12: pts -= 4
        elif eco > 12: pts -= 6
    pts += perf.get("catches", 0) * 8
    if perf.get("catches", 0) >= 3: pts += 4
    pts += perf.get("stumpings", 0) * 12
    pts += perf.get("runOutDirect", 0) * 12
    pts += perf.get("runOutIndirect", 0) * 6
    return round(pts, 1)


def apply_mult(base, is_cap, is_vc):
    if is_cap: return base * 2
    if is_vc: return base * 1.5
    return base


# ─── DB helpers ───
def get_live_match(db):
    return db.matches.find_one({"status": {"$in": ["live", "toss_done"]}})


def get_user_by_name(db, name_query):
    """Fuzzy match a user name."""
    name_query = name_query.strip().lower()
    users = list(db.users.find())
    # Exact match first
    for u in users:
        if u["name"].lower() == name_query:
            return u
    # Partial match
    for u in users:
        if name_query in u["name"].lower() or u["name"].lower() in name_query:
            return u
    return None


def get_standings(db, match_id):
    """Get current match standings sorted by points."""
    league = db.leagues.find_one({"season": "IPL_2026"})
    if not league:
        return []
    member_ids = league.get("members", [])
    teams = list(db.fantasyteams.find({"matchId": match_id, "userId": {"$in": member_ids}}))

    standings = []
    for team in teams:
        user = db.users.find_one({"_id": team["userId"]})
        if not user:
            continue
        standings.append({
            "userId": str(team["userId"]),
            "userName": user.get("name", "?"),
            "totalPoints": team.get("totalPoints", 0),
            "team": team,
        })
    standings.sort(key=lambda x: x["totalPoints"], reverse=True)
    for i, s in enumerate(standings):
        s["rank"] = i + 1
    return standings


def get_team_detail(db, match_id, user_id):
    """Get a user's team with player names, roles, points."""
    team = db.fantasyteams.find_one({"matchId": match_id, "userId": user_id})
    if not team:
        return None

    perfs = {str(p["playerId"]): p for p in db.playerperformances.find({"matchId": match_id})}
    players_info = []
    for pid in team.get("players", []):
        player = db.players.find_one({"_id": pid})
        if not player:
            continue
        perf = perfs.get(str(pid), {})
        pts = calculate_fantasy_points(perf, player.get("role", "BAT")) if perf else 0
        is_cap = str(team.get("captain", "")) == str(pid)
        is_vc = str(team.get("viceCaptain", "")) == str(pid)
        final_pts = apply_mult(pts, is_cap, is_vc)
        players_info.append({
            "name": player["name"],
            "role": player.get("role", "?"),
            "franchise": player.get("franchise", "?"),
            "basePts": pts,
            "finalPts": final_pts,
            "tag": "(C)" if is_cap else "(VC)" if is_vc else "",
            "batting": f"{perf.get('runs', 0)}({perf.get('ballsFaced', 0)})" if perf.get("didBat") else "-",
            "bowling": f"{perf.get('wickets', 0)}/{perf.get('runsConceded', 0)} ({perf.get('oversBowled', 0)}ov)" if perf.get("oversBowled", 0) > 0 else "-",
        })
    players_info.sort(key=lambda x: x["finalPts"], reverse=True)
    return {"players": players_info, "totalPoints": team.get("totalPoints", 0)}


def compute_what_takes(db, match_id, target_user_id, standings, target_rank=3):
    """What does it take for target_user to reach target_rank?"""
    perfs = {str(p["playerId"]): p for p in db.playerperformances.find({"matchId": match_id})}
    players_db = {str(p["_id"]): p for p in db.players.find({"isActive": True})}

    target_standing = next((s for s in standings if s["userId"] == target_user_id), None)
    if not target_standing:
        return None

    current_rank = target_standing["rank"]
    if current_rank <= target_rank:
        return f"Already at #{current_rank}! No improvement needed."

    # Points needed to overtake rank target_rank
    target_pts = standings[target_rank - 1]["totalPoints"] if len(standings) >= target_rank else 0
    pts_gap = target_pts - target_standing["totalPoints"]

    if pts_gap <= 0:
        return f"Already ahead of #{target_rank} by {-pts_gap} pts."

    team = target_standing["team"]
    best_scenarios = []

    for pid_obj in team.get("players", []):
        pid = str(pid_obj)
        perf = perfs.get(pid)
        player = players_db.get(pid)
        if not perf or not player:
            continue

        role = player.get("role", "BAT")
        name = player["name"]
        is_cap = str(team.get("captain", "")) == pid
        is_vc = str(team.get("viceCaptain", "")) == pid
        mult = 2.0 if is_cap else 1.5 if is_vc else 1.0
        tag = " (C 2x)" if is_cap else " (VC 1.5x)" if is_vc else ""

        current_pts = apply_mult(calculate_fantasy_points(perf, role), is_cap, is_vc)

        # Batting scenario — only if at crease
        if perf.get("didBat") and not perf.get("isDismissed") and role in ("BAT", "WK", "AR"):
            runs = perf.get("runs", 0)
            # How many runs needed to close the gap?
            # Each run = 1pt * multiplier
            runs_needed = max(1, int(pts_gap / mult) + 1)
            projected_total = runs + runs_needed
            if projected_total <= 120:  # realistic T20 ceiling
                sr = (runs / max(perf.get("ballsFaced", 1), 1)) * 100
                balls_needed = int(runs_needed / (sr / 100)) if sr > 0 else runs_needed
                best_scenarios.append({
                    "event": f"{name}{tag} scores {runs_needed} more runs (reach {projected_total})",
                    "detail": f"Currently {runs}({perf.get('ballsFaced', 0)}), SR {sr:.0f}. Needs ~{balls_needed} balls at current pace.",
                    "gain": round(runs_needed * mult, 1),
                })

        # Bowling scenario — only if bowling with overs left
        if perf.get("oversBowled", 0) > 0 and perf.get("oversBowled", 0) < 4 and role in ("BOWL", "AR"):
            wk = perf.get("wickets", 0)
            # Each wicket = 25pts * multiplier
            wickets_needed = max(1, int(pts_gap / (25 * mult)) + 1)
            if wk + wickets_needed <= 5:  # realistic
                best_scenarios.append({
                    "event": f"{name}{tag} takes {wickets_needed} more wicket(s) ({wk + wickets_needed}W total)",
                    "detail": f"Currently {wk}W in {perf.get('oversBowled', 0)}ov. Each wicket = {25 * mult:.0f} pts.",
                    "gain": round(wickets_needed * 25 * mult, 1),
                })

    best_scenarios.sort(key=lambda x: x["gain"])  # least effort first
    return {
        "current_rank": current_rank,
        "target_rank": target_rank,
        "pts_gap": round(pts_gap, 1),
        "scenarios": best_scenarios[:3],
    }


# ─── Question Parser ───
# RULE: Only reply when we are 100% sure the question is for us AND we have real data.
# Better to stay silent than give wrong/vague answers.

INFINITY_TRIGGERS = ["infinity", "@infinity", "infinity max"]
# Questions that don't need direct @mention — they're clearly about fantasy cricket data
DATA_QUESTION_PATTERNS = [
    r"who\s+(?:all\s+)?ha(?:s|ve)\s+\w",      # "who has Bumrah"
    r"kis\s*kis.*(?:paas|pass|ke)",              # "kis kis ke paas"
    r"kisk[aie]\s+(?:team|squad)",               # "kiska team"
    r"(?:show|dikhao).*team",                    # "show X's team"
    r"\w+'s\s+team",                             # "Meet's team"
    r"(?:standings|leaderboard)\s*\??$",          # just "standings?"
]

def is_question_for_bot(text_lower, mentioned_jids):
    """Strict check: is this message meant for Infinity Max?"""
    # 1. Direct mention of Infinity Max
    if any(t in text_lower for t in INFINITY_TRIGGERS):
        return True
    # 2. Reply to Infinity Max's message (mentionedJids would contain bot's JID)
    # 3. Clear data question pattern (no ambiguity)
    for pattern in DATA_QUESTION_PATTERNS:
        if re.search(pattern, text_lower):
            return True
    return False


def parse_question(text, db, mentioned_jids=None):
    """Parse a group message. Returns None if not for us or can't answer."""
    text_lower = text.lower().strip()

    if not is_question_for_bot(text_lower, mentioned_jids or []):
        return None

    match = get_live_match(db)
    if not match:
        return None  # Stay silent if no live match — don't say "no match"

    # ── Ownership: "who has X" / "kis kis ke paas X" ──
    ownership_match = re.search(
        r"(?:who\s+(?:all\s+)?ha(?:s|ve)|kis\s*kis|kiske?\s*(?:paas|pass))[\s:]+(\w[\w\s]*?)(?:\?|$|in\s)",
        text_lower
    )
    if not ownership_match:
        ownership_match = re.search(r"(\w[\w\s]+?)\s+(?:kis\s*kis|kiske?\s*(?:paas|pass)|who\s*has)", text_lower)
    if ownership_match:
        player_query = ownership_match.group(1).strip()
        # Remove common filler words
        player_query = re.sub(r'^(the|a|an|ye|yeh|wo|woh)\s+', '', player_query)
        if len(player_query) >= 3:  # minimum 3 chars to avoid false matches
            player = db.players.find_one({"name": {"$regex": player_query, "$options": "i"}, "isActive": True})
            if player:
                return {"type": "ownership", "player": player, "match": match}
        return None  # Don't fall through to generic — if they asked "who has X" and X isn't found, stay silent

    # ── Team view: "show X's team" / "kiska team" ──
    team_match = re.search(r"(?:what|kya|show|dikhao).*?(?:team|squad).*?(?:of|for|ka)?\s*(\w[\w\s]*?)(?:\?|$)", text_lower)
    if not team_match:
        team_match = re.search(r"(\w[\w\s]*?)(?:'s|ka|ki)\s*(?:team|squad)", text_lower)
    if team_match:
        user_name = team_match.group(1).strip()
        if len(user_name) >= 2:
            user = get_user_by_name(db, user_name)
            if user:
                return {"type": "team", "user": user, "match": match}
        return None  # User name not found, stay silent

    # ── What it takes: only if they explicitly mention "top 3" etc ──
    if any(p in text_lower for p in ["top 3", "top 5", "podium"]):
        if any(p in text_lower for p in ["kaise", "how", "chahiye", "need", "reach", "possible"]):
            return {"type": "what_takes", "match": match}

    # ── Standings: only if the entire message is about standings ──
    if re.search(r"^(?:standings|leaderboard|ranking|score)\s*\??$", text_lower):
        return {"type": "standings", "match": match}

    # ── Best player: explicit ask ──
    if any(p in text_lower for p in ["which player should", "konsa player", "best player for me", "maximum points ke liye"]):
        return {"type": "best_player", "match": match}

    # ── If they @mentioned Infinity Max but we couldn't parse the question ──
    if any(t in text_lower for t in INFINITY_TRIGGERS):
        return {"type": "summary", "match": match}

    # Default: stay silent. Don't reply to things we're not sure about.
    return None


# ─── Response Builder ───
def build_response(question, db, asker_phone=None):
    """Build a statistically-backed response."""
    if not question:
        return None

    if question["type"] == "no_match":
        return "No live match right now. Check back during match time!"

    match = question["match"]
    match_id = match["_id"]
    standings = get_standings(db, match_id)
    match_label = f"{match['team1']} vs {match['team2']}"

    if question["type"] == "ownership":
        player = question["player"]
        pid = str(player["_id"])
        pname = player["name"]
        role = player.get("role", "?")
        franchise = player.get("franchise", "?")

        # Find who owns this player
        league = db.leagues.find_one({"season": "IPL_2026"})
        member_ids = league.get("members", []) if league else []
        teams = list(db.fantasyteams.find({"matchId": match_id, "userId": {"$in": member_ids}}))

        # Get player's current performance
        perf = db.playerperformances.find_one({"matchId": match_id, "playerId": player["_id"]})
        perf_line = ""
        if perf:
            if perf.get("didBat"):
                status = "not out" if not perf.get("isDismissed") else "out"
                perf_line = f"Batting: {perf.get('runs', 0)}({perf.get('ballsFaced', 0)}) [{status}]"
            if perf.get("oversBowled", 0) > 0:
                bowl = f"Bowling: {perf.get('wickets', 0)}/{perf.get('runsConceded', 0)} ({perf.get('oversBowled', 0)}ov)"
                perf_line = f"{perf_line} | {bowl}" if perf_line else bowl
            pts = calculate_fantasy_points(perf, role)
            perf_line += f" | Fantasy: {pts}pts"

        owners = []
        total_owned = 0
        for team in teams:
            player_ids = [str(p) for p in team.get("players", [])]
            if pid in player_ids:
                total_owned += 1
                user = db.users.find_one({"_id": team["userId"]})
                uname = user.get("name", "?") if user else "?"
                is_cap = str(team.get("captain", "")) == pid
                is_vc = str(team.get("viceCaptain", "")) == pid
                tag = " 👑(C 2x)" if is_cap else " ⭐(VC 1.5x)" if is_vc else ""
                owners.append(f"  • {uname}{tag}")

        total_teams = len(teams)
        pct = round(total_owned / total_teams * 100) if total_teams > 0 else 0

        lines = [f"📊 *{pname}* ({role}/{franchise})\n"]
        if perf_line:
            lines.append(f"📈 {perf_line}\n")
        lines.append(f"Owned by *{total_owned}/{total_teams}* teams ({pct}%):\n")
        lines.extend(owners if owners else ["  Nobody picked this player"])
        return "\n".join(lines)

    if question["type"] == "best_player":
        # Find which player, if they score big, benefits the asker most
        lines = [f"🔮 *Top Fantasy Scorers Right Now — {match_label}*\n"]
        perfs = list(db.playerperformances.find({"matchId": match_id}))
        scored = []
        for perf in perfs:
            player = db.players.find_one({"_id": perf["playerId"]})
            if not player:
                continue
            pts = calculate_fantasy_points(perf, player.get("role", "BAT"))
            status = ""
            if perf.get("didBat") and not perf.get("isDismissed"):
                status = f" 🏏 {perf.get('runs', 0)}({perf.get('ballsFaced', 0)}) NOT OUT"
            elif perf.get("oversBowled", 0) > 0 and perf.get("oversBowled", 0) < 4:
                status = f" 🎯 {perf.get('wickets', 0)}W bowling"
            scored.append((player["name"], player.get("role", "?"), pts, status))
        scored.sort(key=lambda x: x[2], reverse=True)
        for name, role, pts, status in scored[:10]:
            lines.append(f"  {name} ({role}) — {pts}pts{status}")
        return "\n".join(lines)

    if question["type"] == "standings":
        lines = [f"📊 *Live Standings — {match_label}*\n"]
        for s in standings:
            medal = "🥇" if s["rank"] == 1 else "🥈" if s["rank"] == 2 else "🥉" if s["rank"] == 3 else f"{s['rank']}."
            lines.append(f"{medal} {s['userName']} — {s['totalPoints']} pts")
        return "\n".join(lines)

    if question["type"] == "team":
        user = question["user"]
        detail = get_team_detail(db, match_id, user["_id"])
        if not detail:
            return f"{user['name']} hasn't submitted a team for this match."

        lines = [f"📋 *{user['name']}'s Team — {match_label}*\n"]
        lines.append(f"Total: *{detail['totalPoints']} pts*\n")
        for p in detail["players"]:
            pts_str = f"{p['finalPts']}pts" if p['finalPts'] != p['basePts'] else f"{p['basePts']}pts"
            tag = f" {p['tag']}" if p['tag'] else ""
            bat = f" | Bat: {p['batting']}" if p['batting'] != "-" else ""
            bowl = f" | Bowl: {p['bowling']}" if p['bowling'] != "-" else ""
            lines.append(f"  {'👑' if 'C' in tag else '⭐' if 'VC' in tag else '•'} {p['name']} ({p['role']}/{p['franchise']}){tag} — {pts_str}{bat}{bowl}")
        return "\n".join(lines)

    if question["type"] == "what_takes":
        # Find the asker from phone number
        asker = None
        if asker_phone:
            clean_phone = asker_phone.replace("@s.whatsapp.net", "").replace("+", "")
            asker = db.users.find_one({"phone": {"$regex": clean_phone[-10:]}})

        if not asker:
            # Generic top-3 analysis for everyone
            lines = [f"🔮 *What it takes to reach Top 3 — {match_label}*\n"]
            top3_pts = standings[2]["totalPoints"] if len(standings) >= 3 else 0
            lines.append(f"Top 3 cutoff: *{top3_pts} pts*\n")
            for s in standings[3:8]:  # positions 4-8
                gap = round(top3_pts - s["totalPoints"], 1)
                lines.append(f"  {s['userName']} (#{s['rank']}, {s['totalPoints']}pts) — needs +{gap} pts")
            return "\n".join(lines)

        # Specific analysis for the asker
        result = compute_what_takes(db, match_id, str(asker["_id"]), standings)
        if isinstance(result, str):
            return f"🔮 *{asker['name']}:* {result}"
        if not result:
            return f"Couldn't compute scenarios for {asker['name']}."

        lines = [f"🔮 *{asker['name']} — Path to Top {result['target_rank']}*\n"]
        lines.append(f"Current: *#{result['current_rank']}* | Gap: *{result['pts_gap']} pts*\n")

        if result["scenarios"]:
            lines.append("*Realistic paths:*")
            for i, sc in enumerate(result["scenarios"], 1):
                lines.append(f"\n{i}. {sc['event']}")
                lines.append(f"   {sc['detail']}")
                lines.append(f"   Points gained: +{sc['gain']}")
        else:
            lines.append("No realistic single-event path found. Need multiple things to go right.")

        return "\n".join(lines)

    if question["type"] == "summary":
        lines = [f"📊 *Quick Summary — {match_label}*\n"]
        if standings:
            lines.append(f"🥇 Leader: {standings[0]['userName']} ({standings[0]['totalPoints']} pts)")
            if len(standings) >= 2:
                gap = round(standings[0]['totalPoints'] - standings[1]['totalPoints'], 1)
                lines.append(f"🥈 {standings[1]['userName']} ({standings[1]['totalPoints']} pts, {gap} behind)")
            if len(standings) >= 3:
                lines.append(f"🥉 {standings[2]['userName']} ({standings[2]['totalPoints']} pts)")

        lines.append(f"\n💬 Ask me: \"Show X's team\", \"How can I reach top 3?\", \"Standings\"")
        return "\n".join(lines)

    return None


# ─── Send reply ───
def send_reply(msg, asker_phone=None):
    payload = {"to": SPL_GROUP_JID, "message": msg}
    if asker_phone:
        # Tag the person who asked
        clean = asker_phone.replace("@s.whatsapp.net", "")
        payload["mentions"] = [clean]
    try:
        resp = requests.post(WA_URL, json=payload,
                             headers={"Authorization": f"Bearer {WA_TOKEN}"}, timeout=10)
        print(f"  Reply sent: {resp.status_code}")
    except Exception as e:
        print(f"  Reply error: {e}")


# ─── Main Loop ───
def main():
    print(f"[{datetime.now(IST).strftime('%H:%M:%S')}] Infinity Max Listener starting...")

    client = MongoClient(MONGO_URI)
    db = client["test"]

    last_seen_id = None
    last_seen_ts = int(time.time())

    print(f"  Connected to MongoDB. Polling every {POLL_INTERVAL}s...")

    while True:
        try:
            # Fetch recent messages from SPL group
            resp = requests.get(
                f"{WA_MSG_URL}/{SPL_GROUP_JID}",
                params={"limit": 5},
                headers={"Authorization": f"Bearer {WA_TOKEN}"},
                timeout=10,
            )
            if resp.status_code != 200:
                time.sleep(POLL_INTERVAL)
                continue

            data = resp.json()
            messages = data.get("messages", [])

            for msg in reversed(messages):  # oldest first
                msg_id = msg.get("id", "")
                msg_ts = msg.get("timestamp", 0)
                sender = msg.get("from", "")
                text = msg.get("text", "") or msg.get("message", {}).get("conversation", "") or ""
                push_name = msg.get("pushName", "")

                # Skip old messages, own messages, empty
                if msg_ts <= last_seen_ts:
                    continue
                if not text:
                    continue
                # Skip messages from Infinity Max itself
                if "infinity" in push_name.lower() or sender.endswith("@lid"):
                    continue

                last_seen_ts = msg_ts
                print(f"\n  [{datetime.fromtimestamp(msg_ts, IST).strftime('%H:%M')}] {push_name}: {text[:80]}")

                # Parse and respond
                question = parse_question(text, db)
                if not question:
                    continue

                print(f"  → Detected: {question['type']}")
                response = build_response(question, db, asker_phone=sender)
                if response:
                    print(f"  → Replying ({len(response)} chars)")
                    send_reply(response, asker_phone=sender)

        except KeyboardInterrupt:
            print("\n  Shutting down...")
            break
        except Exception as e:
            print(f"  Error: {e}")

        time.sleep(POLL_INTERVAL)

    client.close()


if __name__ == "__main__":
    main()
