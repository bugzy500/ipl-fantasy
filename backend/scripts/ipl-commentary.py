#!/usr/bin/env python3
"""
IPL Commentary Daemon — Cricbuzz → Postgres → LLM → WhatsApp

Polls Cricbuzz live scores page every 60s during match hours.
Extracts ball-by-ball commentary, stores in Postgres, filters hype
via Groq LLM, and forwards exciting moments to WhatsApp group.

Deploy: /opt/services/ipl-scraper/ipl-commentary.py
Start:  PYTHONUNBUFFERED=1 nohup python3 -u ipl-commentary.py > /var/log/ipl-commentary.log 2>&1 &
"""
import os
import re
import json
import time
import requests
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    psycopg2 = None

from pymongo import MongoClient
from bson import ObjectId

# ─── Config (shared with ipl-scraper.py) ───
_env_path = Path(__file__).parent / '.env'
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

MONGO_URI = os.environ.get('MONGO_URI', '')
WA_URL = "https://wa.dotsai.cloud/api/send/text"
WA_TOKEN = os.environ.get('WA_TOKEN', os.environ.get('WHATSAPP_API_TOKEN', ''))
PG_DSN = os.environ.get('PG_DSN', 'postgresql://dotsai:6a0NxO3mjlcKrA7iYw7aVDnX7kyN9@127.0.0.1:5432/dotsai')
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')
SPL_GROUP_JID = "120363407548600267@g.us"
MEET_PHONE = "917567838028@s.whatsapp.net"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
IST = timezone(timedelta(hours=5, minutes=30))
POLL_INTERVAL = 60  # seconds
STATE_FILE = "/opt/services/ipl-scraper/commentary_state.json"
SCRAPER_STATE_FILE = "/opt/services/ipl-scraper/state.json"

# Anti-spam config
MIN_OVER_GAP = 2.0       # minimum overs between forwarded messages
MIN_TIME_GAP = 180       # minimum seconds between forwarded messages
MAX_PER_MATCH = 15       # max forwarded messages per match
CONFIDENCE_THRESHOLD = 0.7
SCRAPER_COOLDOWN = 60    # don't send within 60s of scraper's last message


# ─── State ───
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except:
        return {"forwarded": {}, "consecutive_failures": 0}

def save_state(state):
    try:
        with open(STATE_FILE, 'w') as f:
            json.dump(state, f, indent=2)
    except:
        pass

def load_scraper_state():
    try:
        with open(SCRAPER_STATE_FILE) as f:
            return json.load(f)
    except:
        return {}


# ─── Cricbuzz Commentary Extraction ───
CANDIDATE_KEYS = ["matchCommentary", "commentaryList", "commDTO", "commentary"]

def extract_commentary(cb_id):
    """
    Fetch Cricbuzz live scores page and extract commentary entries.
    Self-healing: tries multiple JSON key paths.
    Returns list of {ball_metric, innings_id, comm_text, event_type, batsman, bowler, timestamp}
    """
    url = f"https://www.cricbuzz.com/live-cricket-scores/{cb_id}"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        if resp.status_code != 200:
            return None
    except Exception as e:
        print(f"  Fetch error: {e}")
        return None

    # Extract RSC chunks
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', resp.text)
    all_text = ''
    for chunk in chunks:
        try:
            decoded = chunk.encode('utf-8').decode('unicode_escape')
            all_text += decoded
        except:
            all_text += chunk

    # Try each candidate key
    data = None
    for key in CANDIDATE_KEYS:
        pattern = f'"{key}"'
        idx = all_text.find(pattern)
        if idx == -1:
            continue

        # Find the JSON object
        start = all_text.find('{', idx + len(pattern))
        if start == -1:
            continue

        depth = 0
        end = start
        for i in range(start, min(start + 100000, len(all_text))):
            if all_text[i] == '{':
                depth += 1
            elif all_text[i] == '}':
                depth -= 1
            if depth == 0:
                end = i + 1
                break

        try:
            data = json.loads(all_text[start:end])
            break
        except json.JSONDecodeError:
            continue

    if not data:
        # Fallback: regex for commText entries
        comm_matches = re.findall(
            r'"commText"\s*:\s*"([^"]+)".*?"ballMetric"\s*:\s*([\d.]+)',
            all_text
        )
        if comm_matches:
            return [{"ball_metric": float(bm), "innings_id": 1, "comm_text": ct,
                      "event_type": "none", "batsman": "", "bowler": "", "timestamp": 0}
                     for ct, bm in comm_matches]
        return None

    # Parse entries
    entries = []
    for ts_key, entry in data.items():
        if not isinstance(entry, dict):
            continue
        comm_text = entry.get("commText", "")
        if not comm_text:
            continue

        # Skip stat/info entries (HTML content, no ball metric)
        ball_metric = entry.get("ballMetric")
        if ball_metric == "$undefined" or ball_metric is None:
            continue
        try:
            ball_metric = float(ball_metric)
        except (ValueError, TypeError):
            continue

        events = entry.get("event", [])
        event_type = "none"
        for ev in events:
            if ev in ("four", "six", "wicket"):
                event_type = ev
                break

        batsman_details = entry.get("batsmanDetails", {}) or {}
        bowler_details = entry.get("bowlerDetails", {}) or {}

        entries.append({
            "ball_metric": ball_metric,
            "innings_id": entry.get("inningsId", 1),
            "comm_text": re.sub(r'<[^>]+>', '', comm_text),  # strip HTML
            "event_type": event_type,
            "batsman": batsman_details.get("playerName", ""),
            "bowler": bowler_details.get("playerName", ""),
            "timestamp": int(ts_key) if ts_key.isdigit() else 0,
        })

    entries.sort(key=lambda x: x["timestamp"], reverse=True)
    return entries


# ─── Postgres Storage ───
def store_commentary(entries, match_id, cb_id):
    """Store entries in Postgres. Returns list of NEW entries (not seen before)."""
    if not psycopg2 or not entries:
        return entries  # return all if no PG

    new_entries = []
    try:
        conn = psycopg2.connect(PG_DSN)
        cur = conn.cursor()
        for e in entries:
            try:
                cur.execute("""
                    INSERT INTO ipl_commentary (match_id, cb_match_id, ball_metric, innings_id,
                        comm_text, event_type, batsman, bowler)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (cb_match_id, ball_metric, innings_id) DO NOTHING
                    RETURNING id
                """, (match_id, cb_id, e["ball_metric"], e["innings_id"],
                      e["comm_text"], e["event_type"], e["batsman"], e["bowler"]))
                if cur.fetchone():
                    new_entries.append(e)
            except Exception:
                conn.rollback()
                continue
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"  PG error: {e}")
        return entries  # fallback: treat all as new

    return new_entries


# ─── LLM Hype Filter ───
def filter_hype(entries):
    """
    Send recent commentary to Groq LLM. Returns hype verdict.
    Only call when we have interesting events (four, six, wicket) in the batch.
    """
    if not GROQ_API_KEY or not entries:
        return None

    # Only bother LLM if there's a real event
    has_event = any(e["event_type"] in ("four", "six", "wicket") for e in entries)
    if not has_event:
        return None

    # Build context — last 6 balls
    recent = entries[:6]
    context_lines = []
    for e in recent:
        tag = f"[{e['event_type'].upper()}]" if e["event_type"] != "none" else ""
        context_lines.append(f"{e['ball_metric']}: {e['comm_text']} {tag}")

    prompt = f"""From these last 6 balls of cricket commentary, pick the SINGLE most exciting moment.
Reply with JSON only: {{"hype": true/false, "message": "one-liner for WhatsApp group (hinglish ok, max 15 words)", "category": "boundary|wicket|milestone|drama|none", "confidence": 0.0-1.0}}

Commentary:
{chr(10).join(context_lines)}"""

    try:
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": "llama-3.3-70b-versatile",
                "messages": [
                    {"role": "system", "content": "You are a cricket commentary analyst for a fantasy league WhatsApp group. Reply JSON only. Be selective — only hype: true for genuinely exciting moments."},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.3,
                "max_tokens": 150,
            },
            timeout=5,
        )
        if resp.status_code != 200:
            return None

        content = resp.json()["choices"][0]["message"]["content"]
        # Extract JSON from response
        json_match = re.search(r'\{[^}]+\}', content)
        if json_match:
            return json.loads(json_match.group())
    except Exception as e:
        print(f"  Groq error: {e}")

    return None


# ─── Anti-Spam Gate ───
def should_forward(match_id, state):
    """Check all anti-spam conditions. Returns True if OK to send."""
    match_state = state.get("forwarded", {}).get(match_id, {})

    # Max per match
    count = match_state.get("count", 0)
    if count >= MAX_PER_MATCH:
        return False

    # Min time gap
    last_time = match_state.get("last_time", 0)
    if time.time() - last_time < MIN_TIME_GAP:
        return False

    # Min over gap
    last_over = match_state.get("last_over", 0)
    # (checked by caller with current ball_metric)

    # Scraper cooldown — don't overlap with scraper messages
    try:
        scraper_state = load_scraper_state()
        scraper_last = scraper_state.get("last_dm", {}).get(match_id, 0)
        if isinstance(scraper_last, (int, float)) and time.time() - scraper_last < SCRAPER_COOLDOWN:
            return False
    except:
        pass

    return True


def record_forward(match_id, ball_metric, state):
    """Record that we forwarded a message."""
    if match_id not in state.get("forwarded", {}):
        state.setdefault("forwarded", {})[match_id] = {"count": 0, "last_time": 0, "last_over": 0}
    ms = state["forwarded"][match_id]
    ms["count"] = ms.get("count", 0) + 1
    ms["last_time"] = time.time()
    ms["last_over"] = ball_metric


# ─── WhatsApp ───
def send_group(msg):
    try:
        resp = requests.post(WA_URL, json={"to": SPL_GROUP_JID, "message": msg},
                             headers={"Authorization": f"Bearer {WA_TOKEN}"}, timeout=10)
        return resp.status_code == 200 and resp.json().get("success")
    except:
        return False

def send_alert(msg):
    """DM Meet for alerts."""
    try:
        requests.post(WA_URL, json={"to": MEET_PHONE, "message": msg},
                      headers={"Authorization": f"Bearer {WA_TOKEN}"}, timeout=10)
    except:
        pass


# ─── Main Loop ───
def main():
    print(f"[{datetime.now(IST).strftime('%H:%M:%S')}] IPL Commentary Daemon starting...")

    client = MongoClient(MONGO_URI)
    db = client["test"]
    state = load_state()

    print(f"  MongoDB connected. Polling every {POLL_INTERVAL}s")

    while True:
        try:
            now_ist = datetime.now(IST)
            hour = now_ist.hour

            # Only run during match hours (14:00-23:59, 00:00-01:59 IST)
            if not (14 <= hour <= 23 or 0 <= hour <= 1):
                time.sleep(POLL_INTERVAL)
                continue

            # Find live matches with Cricbuzz IDs
            live_matches = list(db.matches.find({
                "status": {"$in": ["live", "toss_done"]},
                "cricApiMatchId": {"$exists": True, "$ne": ""},
            }))

            for match in live_matches:
                cb_id = match["cricApiMatchId"]
                match_id = str(match["_id"])

                # Extract commentary
                entries = extract_commentary(cb_id)
                if entries is None:
                    state["consecutive_failures"] = state.get("consecutive_failures", 0) + 1
                    if state["consecutive_failures"] >= 3:
                        send_alert(f"⚠️ Commentary extraction failed 3x for CB#{cb_id}")
                        state["consecutive_failures"] = 0
                    continue

                state["consecutive_failures"] = 0

                if not entries:
                    continue

                print(f"  [{now_ist.strftime('%H:%M')}] CB#{cb_id}: {len(entries)} commentary entries")

                # Store in Postgres (returns only NEW entries)
                new_entries = store_commentary(entries, match_id, cb_id)
                if not new_entries:
                    continue

                print(f"    {len(new_entries)} new entries stored")

                # Check anti-spam
                if not should_forward(match_id, state):
                    continue

                # Check over gap
                match_state = state.get("forwarded", {}).get(match_id, {})
                last_over = match_state.get("last_over", 0)
                current_over = max(e["ball_metric"] for e in new_entries)
                if current_over - last_over < MIN_OVER_GAP and last_over > 0:
                    continue

                # LLM filter
                verdict = filter_hype(new_entries)
                if not verdict or not verdict.get("hype") or verdict.get("confidence", 0) < CONFIDENCE_THRESHOLD:
                    continue

                # Forward!
                msg = f"🏏 *{verdict.get('message', '')}*"
                category = verdict.get("category", "")
                if category == "wicket":
                    msg = f"🔥 *{verdict.get('message', '')}*"
                elif category == "boundary":
                    msg = f"💥 *{verdict.get('message', '')}*"

                print(f"    → Forwarding: {msg}")
                if send_group(msg):
                    record_forward(match_id, current_over, state)

                    # Mark hype in Postgres
                    if psycopg2:
                        try:
                            conn = psycopg2.connect(PG_DSN)
                            cur = conn.cursor()
                            cur.execute("""
                                UPDATE ipl_commentary SET is_hype = TRUE, hype_message = %s, forwarded_at = NOW()
                                WHERE cb_match_id = %s AND ball_metric = %s
                            """, (verdict.get("message", ""), cb_id, current_over))
                            conn.commit()
                            cur.close()
                            conn.close()
                        except:
                            pass

        except KeyboardInterrupt:
            print("\n  Shutting down...")
            break
        except Exception as e:
            print(f"  Error: {e}")

        save_state(state)
        time.sleep(POLL_INTERVAL)

    client.close()


if __name__ == "__main__":
    main()
