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
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    psycopg2 = None
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
# PostgreSQL GIF cache (multi-project shared pool)
PG_DSN = os.environ.get('PG_DSN', 'postgresql://dotsai:6a0NxO3mjlcKrA7iYw7aVDnX7kyN9@127.0.0.1:5432/dotsai')
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
IST = timezone(timedelta(hours=5, minutes=30))
DM_INTERVAL_MIN = 15
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

    # Batting (only if player batted — matches Node.js scoring.service.js)
    if perf.get("didBat"):
        pts += runs * 1.0
        pts += perf.get("fours", 0) * 1.0
        pts += perf.get("sixes", 0) * 2.0
        if runs >= 100: pts += 16.0
        elif runs >= 50: pts += 8.0
        if runs == 0 and perf.get("isDismissed") and role != "BOWL":
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
    pts += perf.get("dotBalls", 0) * 2.0
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


MENTION_NAME_OVERRIDES = {
    "Daddy Cool": "Avdhesh",
    "VVS": "Vaishali",
    "Jayesh sharma": "Jayesh",
    "Shubham Sharma": "Shubham",
    "Arpit Garg": "Arpit",
    "Meet": "Meet",
    "Prashast": "Prashast",
    "Nishant": "Nishant",
    "Navneet": "Navneet",
    "Rahul Sharma": "Rahul",
    "Shashwat": "Shashwat",
    "Kurja": "Kurja",
    "IKCyas": "IKCyas",
    "Infinity Max": "InfinityMax",
}


def normalize_phone(phone):
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    return digits if len(digits) >= 10 else None


def mention_label(name):
    label = MENTION_NAME_OVERRIDES.get(name, (name or "Player").strip().split()[0] or "Player")
    clean = re.sub(r"[^A-Za-z0-9_]+", "", label)
    return f"@{clean or 'Player'}"


def mention_entry(name, phone):
    """Returns (@phone_for_body, phone_for_mentions_array) when phone available.
    Gateway needs @phonenumber in the message body to actually ping."""
    normalized = normalize_phone(phone)
    if normalized:
        return f"@{normalized}", normalized
    # No phone — fall back to display name (won't ping but at least readable)
    label = MENTION_NAME_OVERRIDES.get(name, (name or "Player").strip().split()[0] or "Player")
    return label, None


def render_user_refs(users):
    labels = []
    mentions = []
    for user in users or []:
        label, phone = mention_entry(user.get("name"), user.get("phone"))
        labels.append(label)
        if phone:
            mentions.append(phone)
    if not labels:
        return "", []
    return ", ".join(labels), dedupe_mentions(mentions)


def dedupe_mentions(mentions):
    seen = set()
    ordered = []
    for phone in mentions or []:
        normalized = normalize_phone(phone)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def send_group(message, mentions=None):
    """Send message to Saanp Premier League group."""
    try:
        payload = {"to": SPL_GROUP_JID, "message": message}
        mention_list = dedupe_mentions(mentions)
        if mention_list:
            payload["mentions"] = mention_list

        r = requests.post(WA_URL, json=payload,
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


def send_group_gif(gif_url, caption="", mentions=None):
    """Send media to the group with optional caption. Falls back to text if media fails."""
    try:
        mention_list = dedupe_mentions(mentions)
        # Try as video first so the group sees an actual moving GIF/video, not a flattened still image.
        payload = {"to": SPL_GROUP_JID, "type": "video", "url": gif_url, "caption": caption, "gifPlayback": True}
        if mention_list:
            payload["mentions"] = mention_list
        r = requests.post(WA_MEDIA_URL,
                         json=payload,
                         headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                         timeout=15)
        if r.ok:
            print(f"    Group GIF sent")
            return True
        # Retry as image if the gateway rejects the media as video.
        payload = {"to": SPL_GROUP_JID, "type": "image", "url": gif_url, "caption": caption}
        if mention_list:
            payload["mentions"] = mention_list
        r2 = requests.post(WA_MEDIA_URL,
                          json=payload,
                          headers={"Authorization": f"Bearer {WA_TOKEN}", "Content-Type": "application/json"},
                          timeout=15)
        if r2.ok:
            print(f"    Group GIF sent (as video)")
            return True
        print(f"    Group GIF FAILED: {r.status_code} — falling back to text")
        # Fallback: send as plain text
        send_group(caption, mentions=mention_list)
        return False
    except Exception as e:
        print(f"    Group GIF error: {e} — falling back to text")
        send_group(caption, mentions=mentions)
        return False


# ─── Media Pool (all verified 200 OK) ───
# Variety is king: GIFs, avatars, memes — random mix keeps group hyped
AVATAR_BASE_URL = "https://dotsai.in/spl-avatars"

GIFS = {
    "celebration": [
        "https://media.giphy.com/media/1rdLseLhDMiBnumJzM/giphy.mp4",
        "https://media.giphy.com/media/pCJWxPzAbGHHIWHoep/giphy.mp4",
        "https://media.giphy.com/media/E5GdvnFmutdwQhZc22/giphy.mp4",
        "https://media.giphy.com/media/SqoTSUxfRR1PPTXMPv/giphy.mp4",
        "https://media.giphy.com/media/qia2rxxWQ6B01pOf10/giphy.mp4",
        "https://media.giphy.com/media/5wgdVaOwGyWzNxoYKD/giphy.mp4",
        "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.mp4",  # the rock clapping
        "https://media.giphy.com/media/l4pTfx2qLszoacZRS/giphy.mp4",  # leo dicaprio toast
    ],
    "wicket": [
        "https://media.giphy.com/media/UMzYGpUkzuwMlT2mXL/giphy.mp4",
        "https://media.giphy.com/media/xW66oX2jHcCpp49uWs/giphy.mp4",
        "https://media.giphy.com/media/THIImhwN2fV2q8EOvq/giphy.mp4",
        "https://media.giphy.com/media/xB68elnmZURlOlOUZ1/giphy.mp4",
        "https://media.giphy.com/media/2CUJFvoRXDrUeG1mOS/giphy.mp4",
        "https://media.giphy.com/media/ko8zXh01jZPE4/giphy.mp4",
    ],
    "drama": [
        "https://media.giphy.com/media/e8K0OMxMIZ5j5AxyiA/giphy.mp4",
        "https://media.giphy.com/media/ItOC6bcYSUE3QdQPwU/giphy.mp4",
        "https://media.giphy.com/media/NvlwExVCntLTqXVg7X/giphy.mp4",
        "https://media.giphy.com/media/evVKsrjZEqVVWvE2VR/giphy.mp4",
        "https://media.giphy.com/media/ksioubEKq0ufcB4z1S/giphy.mp4",
        "https://media.giphy.com/media/tyqcJoNjNv0Fq/giphy.mp4",
        "https://media.giphy.com/media/uWzS6ZLs0AaVOJlgRd/giphy.mp4",
    ],
    "hype": [
        "https://media.giphy.com/media/b1o4elHO8o03C/giphy.mp4",
        "https://media.giphy.com/media/xUySTUZ8A2RJBQitwI/giphy.mp4",
        "https://media.giphy.com/media/11sBLVxIRvnAwt/giphy.mp4",
    ]
}

# All GIFs in one flat pool for static fallback
ALL_GIFS = []
for cat in GIFS.values():
    ALL_GIFS.extend(cat)

# ─── Giphy API (dynamic, anti-repeat) ───
GIPHY_API_KEY = os.environ.get("GIPHY_API_KEY", "")
GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search"

# Per-category search pools — specific enough to skip the top-5 viral repeats
GIPHY_CATEGORY_QUERIES = {
    "celebration": [
        "victory dance party", "goal scored reaction", "yes pumped winning",
        "touchdown celebration nfl", "championship win reaction", "excited cheering crowd",
        "happy dance winning team", "fist pump success",
    ],
    "wicket": [
        "it's over done finished", "mic drop walk away", "savage dismissal",
        "you're out eliminated", "send off celebration", "bowled out stump",
    ],
    "drama": [
        "shocked face reaction", "this is fine everything fine", "nervous sweating",
        "mind blown explosion", "oh no disaster face", "panic button press",
        "watching nervously hide", "covering eyes scared",
    ],
    "hype": [
        "lets go hyped crowd", "pumped energy workout", "fire motivation",
        "crowd goes wild", "goat greatest all time", "on fire unstoppable",
    ],
}

# Per-persona search pools — matched by first name in user_name
# Non-cricket references, tied to their actual vibe
GIPHY_PERSONA_QUERIES = {
    # Prashast — F1 fan, races, speed, podium drama
    "prashast": [
        "formula 1 overtake", "f1 podium champagne", "pit crew fast",
        "race car speed", "f1 lights out start", "lewis hamilton fist pump",
    ],
    # Vaishali — Taylor Swift stan, Eras tour era
    "vaishali": [
        "taylor swift surprised award", "taylor swift era tour dance",
        "swifties reaction concert", "taylor swift shake it off",
        "taylor swift winning speech", "taylor swift shocked happy",
    ],
    # Avdhesh — Punjabi music, Ammy Virk, desi energy
    "avdhesh": [
        "bhangra celebration dance", "punjabi dhol beat",
        "desi wedding dance", "punjabi singer stage",
        "tumbi dance folk", "desi celebration hands up",
    ],
    # Shubham — Zakir Khan comedy, storytelling, relatable writing humour
    "shubham": [
        "stand up comedy crowd laughing", "storyteller on stage",
        "mic drop comedy", "writer typing inspired",
        "comedian pointing relatable", "awkward funny situation",
    ],
    # Jayesh — Rohit Sharma fan (sixer king, chill Hitman energy)
    "jayesh": [
        "casual sixer chill", "effortless six hit",
        "captain cool swagger", "batting hero moment",
        "nonchalant batter walk", "slow motion six cricketer",
    ],
    # Arpit — Virat Kohli fan (aggressive, passionate, fired up)
    "arpit": [
        "aggressive celebration fist pump", "fired up player roar",
        "passionate player intense", "run celebration screaming",
        "battle cry victory sport", "never give up comeback",
    ],
    # Mannu — full of massive unstoppable energy
    "mannu": [
        "too much energy kid", "excited jumping up down",
        "hyper person bouncing", "cannot contain excitement",
        "over enthusiastic reaction", "kid in candy store excited",
    ],
    # Navneet — same vibe as Mannu
    "navneet": [
        "too much energy kid", "excited jumping up down",
        "hyper person bouncing", "cannot contain excitement",
    ],
    # Nishant — professional, composed, office mode
    "nishant": [
        "professional nod suits", "harvey specter confident walk",
        "office win smug smile", "michael scott celebration office",
        "suit up confident", "boardroom approval nod",
    ],
}



def _pg_conn():
    """Get a PostgreSQL connection, or None if psycopg2 unavailable."""
    if not psycopg2 or not PG_DSN:
        return None
    try:
        return psycopg2.connect(PG_DSN, connect_timeout=3)
    except Exception as e:
        print(f"    PG connect error: {e}")
        return None


def _pg_get_unseen(query_tag, seen_ids, limit=10):
    """
    Pull unseen GIFs from the PG cache matching query_tag.
    Returns list of (giphy_id, mp4_url) tuples.
    """
    conn = _pg_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if seen_ids:
                cur.execute(
                    """SELECT giphy_id, mp4_url FROM gif_cache
                       WHERE query_tag = %s AND giphy_id != ALL(%s)
                       ORDER BY used_count ASC, RANDOM() LIMIT %s""",
                    (query_tag, list(seen_ids), limit)
                )
            else:
                cur.execute(
                    """SELECT giphy_id, mp4_url FROM gif_cache
                       WHERE query_tag = %s
                       ORDER BY used_count ASC, RANDOM() LIMIT %s""",
                    (query_tag, limit)
                )
        return [(row["giphy_id"], row["mp4_url"]) for row in cur.fetchall()]
    except Exception as e:
        print(f"    PG read error: {e}")
        return []
    finally:
        conn.close()


def _pg_store(giphy_id, mp4_url, category, query_tag):
    """Store a newly discovered GIF into PG cache. Silently no-ops on conflict."""
    conn = _pg_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO gif_cache (giphy_id, mp4_url, category, query_tag)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (giphy_id) DO NOTHING""",
                (giphy_id, mp4_url, category, query_tag)
            )
        conn.commit()
    except Exception as e:
        print(f"    PG store error: {e}")
    finally:
        conn.close()


def _pg_mark_used(giphy_id):
    """Increment used_count and update last_used timestamp for rotation fairness."""
    conn = _pg_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE gif_cache SET used_count = used_count + 1, last_used = NOW() WHERE giphy_id = %s",
                (giphy_id,)
            )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def fetch_giphy(query, state, limit=25, category="celebration"):
    """
    Fetch a fresh, unseen mp4 GIF. Two-layer strategy:
      1. Giphy API  → stores every new result in PG cache
      2. PG cache   → fallback when API rate-limited or fails
    Dedup tracked via state['seen_giphy_ids'] (rolling window of 500).
    """
    seen_ids = state.setdefault("seen_giphy_ids", [])
    seen_set = set(seen_ids)

    def _pick_and_record(giphy_id, mp4_url):
        seen_ids.append(giphy_id)
        if len(seen_ids) > 500:
            state["seen_giphy_ids"] = seen_ids[-400:]
        _pg_mark_used(giphy_id)
        return mp4_url

    # ── Layer 1: Giphy API ──
    if GIPHY_API_KEY:
        try:
            offset = random.randint(5, 200)
            r = requests.get(GIPHY_SEARCH_URL, params={
                "api_key": GIPHY_API_KEY,
                "q": query,
                "limit": limit,
                "offset": offset,
                "rating": "pg-13",
                "lang": "en",
            }, timeout=8)

            if r.ok:
                data = r.json().get("data", [])
                random.shuffle(data)
                for gif in data:
                    gif_id = gif.get("id", "")
                    mp4_url = (gif.get("images", {}).get("original_mp4", {}).get("mp4", "")
                               or gif.get("images", {}).get("fixed_height_small", {}).get("mp4", ""))
                    if not mp4_url:
                        continue
                    # Always store in PG (builds up the shared pool over time)
                    _pg_store(gif_id, mp4_url, category, query)
                    if gif_id in seen_set:
                        continue
                    return _pick_and_record(gif_id, mp4_url)

                # All from API already seen — clear half and retry from PG
                state["seen_giphy_ids"] = seen_ids[len(seen_ids)//2:]
                seen_set = set(state["seen_giphy_ids"])
            else:
                print(f"    Giphy API rate-limited ({r.status_code}) — falling back to PG cache")
        except Exception as e:
            print(f"    Giphy fetch error ({query}): {e}")

    # ── Layer 2: PG cache fallback ──
    cached = _pg_get_unseen(query, seen_set, limit=10)
    if cached:
        giphy_id, mp4_url = random.choice(cached)
        print(f"    Using PG cache for '{query}' → {giphy_id[:8]}...")
        return _pick_and_record(giphy_id, mp4_url)

    return None




def get_contextual_query(event_type, context=None):
    """
    Derive a sentiment-specific Giphy search query from live match data.
    Takes the actual match numbers and returns a pinpoint search term
    instead of a bland category name — makes every GIF feel earned.
    """
    ctx = context or {}

    # ─ Batting ───
    if event_type == "fifty":
        sr = ctx.get("sr", 0)
        sixes = ctx.get("sixes", 0)
        if sr > 180:
            return random.choice(["violent hitting slog blitz", "blazing batting carnage boundary"])
        elif sr > 140 or sixes >= 3:
            return random.choice(["aggressive batter pumped up", "big hitting fist pump"])
        elif sr < 100:
            return random.choice(["gritty innings relief exhausted", "hard fought milestone relief"])
        return random.choice(["half century raise bat milestone", "fifty cricket celebration"])

    if event_type == "century":
        sr = ctx.get("sr", 0)
        if sr > 160:
            return random.choice(["fastest hundred blitz speed", "century carnage batting legend"])
        return random.choice(["century arms open emotional crowd", "hundred milestone standing ovation"])

    if event_type == "150":
        return random.choice(["unstoppable power hitting destruction", "batting god record breaking"])

    # ─ Wicket types ───
    if event_type == "wicket_bowled":
        return random.choice(["clean bowled stumps flying shocked", "bowled through gate stump cartwheels"])

    if event_type == "wicket_lbw":
        return random.choice(["trapped lbw finger raised appeal", "out lbw celebration appeal"])

    if event_type == "wicket_caught":
        sixes = ctx.get("sixes", 0)
        if sixes >= 2:
            return random.choice(["caught in deep mistimed slog", "top edge caught boundary"])
        return random.choice(["brilliant catch slip diving", "taken clean catch celebration"])

    if event_type == "wicket_stumped":
        return random.choice(["lightning stumping keeper quick hands", "stumped beaten in flight"])

    if event_type == "wicket_runout":
        return random.choice(["direct hit run out brilliant fielding", "run out backing up shocked"])

    if event_type == "wicket_cheap":
        runs = ctx.get("runs", 0)
        if runs == 0:
            return random.choice(["golden duck walk shame", "duck out first ball shocked"])
        return random.choice(["cheap dismissal early wicket frustration", "soft dismissal disappointing"])

    # ─ Bowling ───
    if event_type == "3wkt":
        eco = ctx.get("economy", 0)
        if eco < 6:
            return random.choice(["bowling spell dominant miser", "three wickets cheap on fire"])
        return random.choice(["wicket burst hat-trick hunt bowling", "bowling attack three wickets surge"])

    if event_type == "fifer":
        return random.choice(["five wicket haul legendary hall fame", "fifer bowling masterclass destroy"])

    if event_type == "maiden":
        return random.choice(["maiden over dots squeeze pressure", "miser bowler economy miserly"])

    # ─ Team score in context ───
    if event_type == "team_score":
        runs = ctx.get("runs", 0)
        rr = ctx.get("rr", 0)
        innings_num = ctx.get("innings_num", 0)
        wickets = ctx.get("wickets", 0)
        if runs >= 200:
            return random.choice(["200 mammoth total batting carnage", "huge score batting celebration"])
        elif rr > 10 and wickets < 4:
            return random.choice(["high run rate explosive fireworks", "boundary machine hitting carnage"])
        elif innings_num == 1 and wickets >= 6:
            return random.choice(["fighting partnership recovery innings", "tail wagging lower order resist"])
        return random.choice(["team milestone score building", "steady progress partnership cricket"])

    # ─ Innings break ───
    if event_type == "innings_break":
        target = ctx.get("target", 0)
        if target > 220:
            return random.choice(["impossible mountain daunting target nervous", "huge target impossible mission"])
        elif target > 180:
            return random.choice(["tough target tense nervous chase", "match knife edge tense finish"])
        elif target < 140:
            return random.choice(["easy chase comfortable target confident", "low target relief comfortable"])
        return random.choice(["50 50 match evenly poised balanced", "anything can happen tense balanced"])

    # ─ Leaderboard takeover ───
    if event_type == "takeover":
        rank = ctx.get("rank", 3)
        if rank == 1:
            return random.choice(["number one top spot king throne", "leaderboard leader champion podium"])
        elif rank == 2:
            return random.choice(["hot on heels chasing number one", "second place climbing podium"])
        return random.choice(["climbing up leaderboard momentum surge", "rising up ranks movement"])

    return random.choice(["celebration victory", "shocked reaction", "fired up energy"])


def get_unseen_media(pool, state):
    """Pick from a static pool with local repeat suppression."""
    used = state.setdefault("used_media", []) if state is not None else []
    unseen = [u for u in pool if u not in used]
    if not unseen:
        unseen = pool
        if state is not None:
            state["used_media"] = state["used_media"][len(state["used_media"])//2:]
    choice = random.choice(unseen)
    if state is not None:
        state["used_media"].append(choice)
        if len(state["used_media"]) > 200:
            state["used_media"] = state["used_media"][-100:]
    return choice


def get_persona_media(user_name, state):
    """Try Giphy first with persona query, return None if no match."""
    if not user_name:
        return None
    name_lower = user_name.lower()
    for persona, queries in GIPHY_PERSONA_QUERIES.items():
        if persona in name_lower:
            return fetch_giphy(random.choice(queries), state)
    return None


def pick_media(category, user_id=None, user_name=None, state=None, query_override=None):
    """
    Pick media with Giphy API + anti-repeat suppression.
    Priority:
      1. 25% persona GIF via Giphy (name match)
      2. 25% avatar (user_id)
      3. 35% Giphy: query_override (contextual) OR category query
      4. 15% static fallback pool
    """
    if state is None:
        state = {}
    roll = random.random()

    if user_name and roll < 0.25:
        url = get_persona_media(user_name, state)
        if url:
            return url, False

    if user_id and roll < 0.5:
        return f"{AVATAR_BASE_URL}/{user_id}.png", True

    if roll < 0.85:
        # Use contextual query if available, else fall back to category pool
        if query_override:
            url = fetch_giphy(query_override, state)
            if url:
                return url, False
        queries = GIPHY_CATEGORY_QUERIES.get(category, GIPHY_CATEGORY_QUERIES["celebration"])
        url = fetch_giphy(random.choice(queries), state)
        if url:
            return url, False

    pool = GIFS.get(category, ALL_GIFS)
    return get_unseen_media(pool, state), False


def send_milestone_media(msg, category="celebration", user_id=None, user_name=None, state=None, query_override=None):
    """Send milestone message with Giphy-powered media, falls back to static then text."""
    url, is_avatar = pick_media(category, user_id, user_name, state, query_override)
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
                    q = get_contextual_query("fifty", {"sr": sr, "sixes": sixes})
                    send_milestone_media(msg, "celebration", state=state, query_override=q)
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
                    q = get_contextual_query("century", {"sr": sr})
                    send_milestone_media(msg, "celebration", state=state, query_override=q)
                    new_milestones.append(key)

            # 150 (special)
            if runs_scored >= 150:
                key = f"150_{player_name}_{i}"
                if key not in sent_milestones:
                    msg = (f"\U0001f92f *150 UP!* {player_name} is UNSTOPPABLE!\n\n"
                           f"{runs_scored} ({balls}) | {fours}x4, {sixes}x6\n\n"
                           f"This is MADNESS \U0001f525\U0001f525\U0001f525")
                    q = get_contextual_query("150")
                    send_milestone_media(msg, "celebration", state=state, query_override=q)
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
                    q = get_contextual_query("3wkt", {"economy": econ})
                    send_milestone_media(msg, "wicket", state=state, query_override=q)
                    new_milestones.append(key)

            # 5-wicket haul (FIFER!)
            if wk >= 5:
                key = f"fifer_{bowler_name}_{i}"
                if key not in sent_milestones:
                    msg = (f"\U0001f525\U0001f525\U0001f525 *5-WICKET HAUL!* {bowler_name}\n\n"
                           f"{wk}/{bowl_runs} ({bowl_overs} ov) | Econ {econ}\n\n"
                           f"ABSOLUTE DESTRUCTION! \U0001f4a3\n\n"
                           f"\U0001f4ca {' | '.join(innings_summary)}")
                    q = get_contextual_query("fifer")
                    send_milestone_media(msg, "wicket", state=state, query_override=q)
                    new_milestones.append(key)

            # Maiden over
            if bowl.get("maidens", 0) > 0:
                maiden_count = bowl.get("maidens", 0)
                key = f"maiden_{bowler_name}_{i}_{maiden_count}"
                if key not in sent_milestones:
                    msg = (f"\U0001f6e1\ufe0f *MAIDEN OVER!* {bowler_name}\n\n"
                           f"Dot dot dot dot dot dot! \U0001f525 Economy: {econ}")
                    q = get_contextual_query("maiden")
                    send_milestone_media(msg, "wicket", state=state, query_override=q)
                    new_milestones.append(key)

        # ── Team score milestones ──
        rr = round(runs / overs, 2) if overs > 0 else 0
        for target_score in [50, 100, 150, 200, 250, 300]:
            if runs >= target_score:
                key = f"team_{target_score}_{bat_team}_{i}"
                if key not in sent_milestones:
                    msg = (f"\U0001f4ca *{target_score} UP!* {bat_team} — {runs}/{wickets} ({overs} ov)\n\n"
                           f"{'Run rate: ' + str(rr) + ' RPO' if overs > 0 else ''}")
                    q = get_contextual_query("team_score", {"runs": runs, "rr": rr, "innings_num": i, "wickets": wickets})
                    send_milestone_media(msg, "celebration", state=state, query_override=q)
                    new_milestones.append(key)

        # ── Wicket alerts (new dismissals) ──
        for bat in innings.get("batting", []):
            if bat.get("is_out", False):
                player_name = bat.get("name", "?")
                runs_scored = bat.get("runs", 0)
                balls = bat.get("balls", 0)
                out_desc = bat.get("out_desc", "")
                wc = bat.get("wicket_code", "")
                key = f"out_{player_name}_{i}"
                if key not in sent_milestones:
                    if runs_scored >= 20:
                        msg = (f"\u274c *WICKET!* {player_name} — {runs_scored} ({balls})\n"
                               f"{out_desc}\n\n"
                               f"\U0001f4ca {' | '.join(innings_summary)}")
                        # Wicket-type-specific query
                        wc_map = {
                            "BOWLED":  "wicket_bowled",
                            "LBW":     "wicket_lbw",
                            "CAUGHT":  "wicket_caught",
                            "STUMPED": "wicket_stumped",
                            "RUNOUT":  "wicket_runout",
                        }
                        evt = wc_map.get(wc, "wicket_caught")
                        q = get_contextual_query(evt, {"sixes": bat.get("sixes", 0), "runs": runs_scored})
                        send_milestone_media(msg, "wicket", state=state, query_override=q)
                        new_milestones.append(key)
                    elif runs_scored < 5:
                        msg = (f"\U0001f480 *OUT!* {player_name} gone for {runs_scored} ({balls})\n"
                               f"{out_desc}\n\n"
                               f"\U0001f4ca {' | '.join(innings_summary)}")
                        q = get_contextual_query("wicket_cheap", {"runs": runs_scored})
                        send_milestone_media(msg, "drama", state=state, query_override=q)
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
                q = get_contextual_query("innings_break", {"target": target})
                send_milestone_media(msg, "drama", state=state, query_override=q)
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

    result = {"innings": [], "teams": [], "is_complete": False, "result_text": ""}

    # Check match status from matchHeader if available
    header = data.get("matchHeader", {})
    match_state = header.get("state", "").lower()
    status_text = header.get("status", "")
    result["is_complete"] = match_state == "complete" or "won" in status_text.lower()
    result["result_text"] = status_text  # e.g. "CSK won by 5 wickets"

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
                "dots": bowl.get("dots", 0),
            })

        result["innings"].append(inn)

    return result


# ─── Winner Extraction ───
# Map full team names to abbreviations for prediction matching
FULL_TEAM_NAMES = {
    "chennai super kings": "CSK", "mumbai indians": "MI",
    "royal challengers bengaluru": "RCB", "royal challengers bangalore": "RCB",
    "kolkata knight riders": "KKR", "rajasthan royals": "RR",
    "delhi capitals": "DC", "sunrisers hyderabad": "SRH",
    "punjab kings": "PBKS", "kings xi punjab": "PBKS",
    "lucknow super giants": "LSG", "gujarat titans": "GT",
}

def _extract_winner(result_text, match):
    """Extract winning team abbreviation from result string like 'Chennai Super Kings won by 5 wickets'."""
    if not result_text:
        return None
    rt = result_text.lower()
    # Check if result mentions "won" or "beat"
    if "won" not in rt and "beat" not in rt:
        return None  # Could be a tie/no result
    # Match against full team names
    for full_name, abbr in FULL_TEAM_NAMES.items():
        if full_name in rt:
            return abbr
    # Fallback: check if team1 or team2 abbreviation appears
    t1 = match.get("team1", "")
    t2 = match.get("team2", "")
    if t1.lower() in rt:
        return t1
    if t2.lower() in rt:
        return t2
    return None


# ─── MongoDB Integration ───
def update_match_scores(db, cb_match_id, scorecard):
    """Map parsed scorecard → PlayerPerformance → Fantasy points → Team scores."""

    teams = scorecard.get("teams", [])
    team_abbrs = [TEAM_MAP.get(t.lower(), t) for t in teams]

    # Find match in DB — check both team orders, prefer nearest unlinked match
    match = db.matches.find_one({"cricApiMatchId": str(cb_match_id)})
    if not match and len(team_abbrs) >= 2:
        from datetime import datetime, timedelta
        now = datetime.utcnow()
        window_start = now - timedelta(hours=12)
        # Search both team orders, only unlinked matches near today
        team_filter = {
            "$or": [
                {"team1": team_abbrs[0], "team2": team_abbrs[1]},
                {"team1": team_abbrs[1], "team2": team_abbrs[0]},
            ],
            "cricApiMatchId": {"$in": [None, ""]},
            "scheduledAt": {"$gte": window_start},
        }
        candidates = list(db.matches.find(team_filter).sort("scheduledAt", 1).limit(1))
        if candidates:
            match = candidates[0]
        else:
            # Fallback: try already-linked or any order, still nearest
            fallback_filter = {
                "$or": [
                    {"team1": {"$regex": team_abbrs[0], "$options": "i"},
                     "team2": {"$regex": team_abbrs[1], "$options": "i"}},
                    {"team1": {"$regex": team_abbrs[1], "$options": "i"},
                     "team2": {"$regex": team_abbrs[0], "$options": "i"}},
                ],
                "scheduledAt": {"$gte": window_start},
            }
            candidates = list(db.matches.find(fallback_filter).sort("scheduledAt", 1).limit(1))
            if candidates:
                match = candidates[0]
        if match:
            db.matches.update_one({"_id": match["_id"]}, {"$set": {"cricApiMatchId": str(cb_match_id)}})
            print(f"    Linked {match['team1']} vs {match['team2']} ({match['scheduledAt']}) → CB#{cb_match_id}")

    if not match:
        print(f"    No DB match for CB#{cb_match_id} (teams: {team_abbrs}). Skipping.")
        return None

    match_id = match["_id"]

    # Update match status + result
    result_text = scorecard.get("result_text", "")
    if scorecard.get("is_complete"):
        update_fields = {"status": "completed"}
        if result_text:
            update_fields["result"] = result_text
            # Extract winning team abbreviation from result text
            # e.g. "Chennai Super Kings won by 5 wickets" → find matching team
            winner = _extract_winner(result_text, match)
            if winner:
                update_fields["winner"] = winner
        db.matches.update_one({"_id": match_id}, {"$set": update_fields})
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
        # Also index by aliases (handles spelling variants like Suryavanshi/Sooryavanshi)
        for alias in p.get("aliases", []):
            alias_clean = alias.strip().lower()
            players_by_name[alias_clean] = p
            alias_parts = alias_clean.split()
            if len(alias_parts) > 1:
                players_by_name[alias_parts[-1]] = p

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
                "lbwBowledWickets": 0, "dotBalls": 0,
                "catches": 0, "stumpings": 0, "runOutDirect": 0, "runOutIndirect": 0,
            }
        return performances[pid]

    # Build cb_id -> player map for fielding lookups.
    # Two-pass: first scan ALL innings to build the complete map so that
    # fielders from inning 2 are resolvable during inning 1 dismissals
    # (e.g. Pant catches during the opposition's batting before LSG bats).
    cb_to_player = {}
    for _inn in scorecard["innings"]:
        for _b in _inn["batting"]:
            _p = find_player(_b["name"], _b.get("cb_id"))
            if _p and _b.get("cb_id"):
                cb_to_player[_b["cb_id"]] = _p
        for _bw in _inn["bowling"]:
            _p = find_player(_bw["name"], _bw.get("cb_id"))
            if _p and _bw.get("cb_id"):
                cb_to_player[_bw["cb_id"]] = _p

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
                bowler = cb_to_player.get(bat["bowler_id"]) or find_player(cb_id=bat["bowler_id"])
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
            perf["dotBalls"] = bowl.get("dots", 0)

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

    # Evaluate predictions if match is completed
    # Re-fetch match to get updated result/winner fields
    match = db.matches.find_one({"_id": match_id})
    prediction_bonus = {}  # userId → bonus points
    if match.get("status") == "completed" and match.get("winner"):
        winner = match["winner"]
        preds = list(db.predictions.find({"matchId": match_id}))
        for pred in preds:
            is_correct = pred.get("predictedWinner") == winner
            bonus = 25 if is_correct else 0
            # Super-over prediction bonus
            if pred.get("predictionType") == "superover":
                result_text = match.get("result", "")
                has_super_over = "super over" in result_text.lower() if result_text else False
                is_correct = has_super_over
                bonus = 80 if is_correct else 0
            db.predictions.update_one(
                {"_id": pred["_id"]},
                {"$set": {"isCorrect": is_correct, "bonusPoints": bonus}}
            )
            uid = str(pred["userId"])
            prediction_bonus[uid] = prediction_bonus.get(uid, 0) + bonus
        if preds:
            correct_count = sum(1 for p in preds if p.get("predictedWinner") == winner)
            print(f"    Predictions: {len(preds)} evaluated, {correct_count} correct ({winner} won)")

    # Recalculate fantasy teams (includes prediction bonus for completed matches)
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
        # Add prediction bonus (idempotent: always recalculated from prediction records)
        uid = str(team.get("userId"))
        total += prediction_bonus.get(uid, 0)
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


# ─── ESPN Dot Ball Integration ───
# Cricbuzz scorecard never provides dot ball data (dots field always 0).
# ESPN's public API reliably returns per-bowler dot ball counts.
# This runs once per completed match, fetching dots and patching performances.

ESPN_API_URL = "https://site.api.espn.com/apis/site/v2/sports/cricket/8048"
_espn_schedule = None  # cached schedule


def _get_espn_schedule():
    """Fetch IPL 2026 schedule from ESPN (cached per scraper run)."""
    global _espn_schedule
    if _espn_schedule is not None:
        return _espn_schedule
    try:
        r = requests.get(f"{ESPN_API_URL}/scoreboard?dates=2026&limit=100",
                         headers=HEADERS, timeout=15)
        if r.status_code == 200:
            events = r.json().get("events", [])
            _espn_schedule = []
            for ev in events:
                comps = ev.get("competitions", [{}])
                teams = [c.get("team", {}).get("abbreviation", "")
                         for c in comps[0].get("competitors", [])] if comps else []
                _espn_schedule.append({
                    "espn_id": ev.get("id"),
                    "teams": teams,
                    "date": ev.get("date", "")[:10],
                })
            return _espn_schedule
    except Exception as e:
        print(f"    ESPN schedule fetch error: {e}")
    _espn_schedule = []
    return _espn_schedule


def _find_espn_event_id(match):
    """Find ESPN event ID for a match by matching teams + date."""
    # If already stored, use it
    if match.get("espnMatchId"):
        return match["espnMatchId"]

    schedule = _get_espn_schedule()
    t1 = match.get("team1", "").upper()
    t2 = match.get("team2", "").upper()
    match_date = match.get("scheduledAt")
    if match_date:
        match_date_str = match_date.strftime("%Y-%m-%d") if hasattr(match_date, 'strftime') else str(match_date)[:10]
    else:
        match_date_str = ""

    for ev in schedule:
        ev_teams = set(t.upper() for t in ev["teams"])
        if t1 in ev_teams and t2 in ev_teams:
            return ev["espn_id"]
        # Also match by date if teams don't match exactly (abbreviation differences)
        if match_date_str and ev["date"] == match_date_str and len(ev_teams & {t1, t2}) >= 1:
            return ev["espn_id"]

    return None


def update_dot_balls_from_espn(db, match, players_by_name):
    """
    Fetch dot balls from ESPN API and patch PlayerPerformance records.
    Only runs for completed matches that haven't been patched yet.
    Returns number of records updated.
    """
    match_id = match["_id"]

    # Skip if already fetched
    if match.get("espnMatchId"):
        return 0

    # Only for completed matches
    if match.get("status") != "completed":
        return 0

    # Check if any bowler already has dotBalls > 0 (already patched)
    has_dots = db.playerperformances.find_one({
        "matchId": match_id, "oversBowled": {"$gt": 0}, "dotBalls": {"$gt": 0}
    })
    if has_dots:
        return 0

    espn_id = _find_espn_event_id(match)
    if not espn_id:
        print(f"    No ESPN event found for {match.get('team1')} vs {match.get('team2')}")
        return 0

    print(f"    Fetching dot balls from ESPN (event {espn_id})...")
    try:
        r = requests.get(f"{ESPN_API_URL}/summary?event={espn_id}",
                         headers=HEADERS, timeout=15)
        if r.status_code != 200:
            print(f"    ESPN API returned {r.status_code}")
            return 0

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
            print(f"    No dot ball data from ESPN")
            return 0

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
                continue

            result = db.playerperformances.update_one(
                {"playerId": player["_id"], "matchId": match_id, "oversBowled": {"$gt": 0}},
                {"$set": {"dotBalls": dots}}
            )
            if result.modified_count > 0:
                updated += 1

        # Store ESPN ID and recalculate if we updated anything
        db.matches.update_one({"_id": match_id}, {"$set": {"espnMatchId": str(espn_id)}})

        if updated > 0:
            # Recalculate fantasy points for affected bowlers
            perfs = list(db.playerperformances.find({"matchId": match_id}))
            players_list = list(db.players.find({}))
            pid_to_player = {str(p["_id"]): p for p in players_list}
            player_points = {}

            for perf in perfs:
                pid = str(perf["playerId"])
                p = pid_to_player.get(pid)
                role = p.get("role", "batsman") if p else "batsman"
                pts = calculate_fantasy_points(perf, role)
                if pts != perf.get("fantasyPoints", 0):
                    db.playerperformances.update_one(
                        {"_id": perf["_id"]}, {"$set": {"fantasyPoints": pts}}
                    )
                player_points[pid] = pts

            # Recalculate team totals
            for team in db.fantasyteams.find({"matchId": match_id}):
                total = 0.0
                for p_id in team.get("players", []):
                    base = player_points.get(str(p_id), 0)
                    is_cap = str(team.get("captain")) == str(p_id)
                    is_vc = str(team.get("viceCaptain")) == str(p_id)
                    total += apply_multiplier(base, is_cap, is_vc)
                db.fantasyteams.update_one({"_id": team["_id"]}, {"$set": {"totalPoints": round(total, 1)}})

            print(f"    ESPN dot balls: {updated} bowlers patched, points recalculated")

        return updated

    except Exception as e:
        print(f"    ESPN dot ball error: {e}")
        return 0


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
        current[ts["userName"]] = {
            "rank": i + 1,
            "points": ts["totalPoints"],
            "userId": ts.get("userId", ""),
            "phone": ts.get("phone", ""),
        }

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

            # Only podium moves count as takeovers. Anything outside the top 3 is noise.
            if cur_rank < prev_rank and cur_rank <= 3 and points_gained > 0:
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
                        "phone": cur_info.get("phone", ""),
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
        rank = to["cur_rank"]
        takeover_mentions = dedupe_mentions([to.get("phone")])
        if rank <= 3:
            cat = "celebration" if rank <= 2 else "hype"
            url, _ = pick_media(cat, user_id=to.get("userId"), user_name=to["name"], state=state)
            send_group_gif(url, msg, mentions=takeover_mentions)
        else:
            send_group(msg, mentions=takeover_mentions)
        sent_takeovers.add(dedup)
        print(f"    Takeover: {to['name']} #{to['prev_rank']}->{to['cur_rank']} (overtook {overtaken_names})")

    # Save current rankings as previous for next run
    state.setdefault("last_dm", {})[rankings_key] = current
    if sent_takeovers:
        state["last_dm"][takeover_dedup_key] = list(sent_takeovers)


# ─── What-It-Takes: dynamic per-update insights ───
def compute_what_it_takes(db, match, team_scores):
    """
    Find the MOST IMPACTFUL realistic events that can still happen.
    Changes every update as match state evolves.
    Returns list of insight strings (max 5).
    """
    if not team_scores or len(team_scores) < 2:
        return []

    match_id = match["_id"]
    perfs_raw = list(db.playerperformances.find({"matchId": match_id}))
    perf_by_pid = {str(p["playerId"]): p for p in perfs_raw}
    players_raw = {str(p["_id"]): p for p in db.players.find({"isActive": True})}

    league = db.leagues.find_one({"season": "IPL_2026"})
    if not league:
        return []
    member_ids = league.get("members", [])
    teams = list(db.fantasyteams.find({"matchId": match_id, "userId": {"$in": member_ids}}))
    user_cache = {}
    for t in teams:
        u = db.users.find_one({"_id": t["userId"]})
        if u:
            user_cache[str(t["userId"])] = u.get("name", "?")

    # Build current rankings from team_scores
    current_ranks = {}
    current_pts_map = {}
    for i, ts in enumerate(team_scores):
        uid = str(ts.get("userId", ts.get("_id", "")))
        current_ranks[uid] = i + 1
        current_pts_map[uid] = ts.get("totalPoints", 0)

    def calc_team_pts(team, override_pid=None, override_perf=None):
        total = 0
        for pid_obj in team.get("players", []):
            pid = str(pid_obj)
            perf = override_perf if pid == override_pid else perf_by_pid.get(pid)
            player = players_raw.get(pid)
            if not perf or not player:
                continue
            pts = calculate_fantasy_points(perf, player.get("role", "BAT"))
            is_cap = str(team.get("captain", "")) == pid
            is_vc = str(team.get("viceCaptain", "")) == pid
            total += apply_multiplier(pts, is_cap, is_vc)
        return round(total, 1)

    # Find ALL active players (still batting or bowling)
    active_pids = set()
    for pid, perf in perf_by_pid.items():
        is_batting = perf.get("didBat") and not perf.get("isDismissed")
        is_bowling = perf.get("oversBowled", 0) > 0 and perf.get("oversBowled", 0) < 4
        if is_batting or is_bowling:
            active_pids.add(pid)

    if not active_pids:
        return ["  Match nearly done — no active batsmen/bowlers left"]

    # For each active player, simulate ONE realistic event and find all rank swaps
    all_scenarios = []

    for pid in active_pids:
        perf = perf_by_pid[pid]
        player = players_raw.get(pid)
        if not player:
            continue
        name = player.get("name", "?")
        role = player.get("role", "BAT")

        events = []
        is_batting = perf.get("didBat") and not perf.get("isDismissed")
        is_bowling = perf.get("oversBowled", 0) > 0 and perf.get("oversBowled", 0) < 4

        if is_batting:
            runs = perf.get("runs", 0)
            bf = perf.get("ballsFaced", 0)
            sr = (runs / bf * 100) if bf > 0 else 130
            # Next milestone
            if runs < 25:
                events.append((f"{name} reaches 25", {**perf, "runs": 25, "ballsFaced": bf + int((25 - runs) / (sr / 100)), "fours": perf.get("fours", 0) + 2}))
            elif runs < 50:
                events.append((f"{name} reaches 50", {**perf, "runs": 50, "ballsFaced": bf + int((50 - runs) / (sr / 100)), "fours": perf.get("fours", 0) + 3, "sixes": perf.get("sixes", 0) + 1}))
            elif runs < 100 and role in ("BAT", "WK"):
                events.append((f"{name} hits century!", {**perf, "runs": 100, "ballsFaced": bf + int((100 - runs) / (sr / 100)), "fours": perf.get("fours", 0) + 5, "sixes": perf.get("sixes", 0) + 3}))
            # Gets out now
            events.append((f"{name} out at {runs}", {**perf, "isDismissed": True}))

        if is_bowling and role in ("BOWL", "AR"):
            wk = perf.get("wickets", 0)
            events.append((f"{name} takes wicket ({wk+1}W)", {**perf, "wickets": wk + 1}))

        # Evaluate each event — find who moves
        for event_label, new_perf in events:
            # Recalc ALL teams with this one player change
            new_scores = []
            for team in teams:
                uid = str(team.get("userId", ""))
                new_pts = calc_team_pts(team, override_pid=pid, override_perf=new_perf)
                new_scores.append((uid, new_pts))
            new_scores.sort(key=lambda x: x[1], reverse=True)

            # Find rank changes
            swaps = []
            for new_rank_idx, (uid, new_pts) in enumerate(new_scores):
                old_rank = current_ranks.get(uid, 99)
                new_rank = new_rank_idx + 1
                if new_rank != old_rank:
                    uname = user_cache.get(uid, "?")
                    swaps.append((uname, old_rank, new_rank))

            if swaps:
                impact = sum(abs(o - n) for _, o, n in swaps)
                all_scenarios.append((event_label, swaps, impact))

    # Sort by impact, deduplicate
    all_scenarios.sort(key=lambda x: x[2], reverse=True)
    seen_events = set()
    insights = []
    for event_label, swaps, impact in all_scenarios:
        if event_label in seen_events:
            continue
        seen_events.add(event_label)
        swap_strs = ", ".join(f"{n} #{o}→#{r}" for n, o, r in swaps[:3])
        insights.append(f"  {event_label} → {swap_strs}")
        if len(insights) >= 5:
            break

    return insights


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
               f"*Top 15 right now:*\n{lb_text}\n\n")

        # Add "What it takes" insights
        try:
            insights = compute_what_it_takes(db, match, all_scores)
            if insights:
                msg += "\U0001f52e *What it takes to climb:*\n"
                msg += "\n".join(insights)
                msg += "\n\n"
        except Exception as e:
            print(f"    What-it-takes error: {e}")

        msg += f"Points updating every 3 min! \U0001f525"
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
                        pending.append({
                            "name": name,
                            "phone": m.get("phone", ""),
                        })

                submitted_text = ", ".join(submitted) if submitted else "Nobody yet!"
                pending_text, pending_mentions = render_user_refs(pending) if pending else ("All done! \U0001f389", [])

                urgency = {40: "\u23f0", 20: "\u26a0\ufe0f", 10: "\U0001f6a8"}
                mins_display = round(mins_left)

                reminder_emoji = urgency.get(tier_min, "⏰")
                msg = (f"{reminder_emoji} *{match['team1']} vs {match['team2']}* — "
                       f"*{mins_display} min* to deadline!\n\n"
                       f"\u2705 *Submitted:* {submitted_text}\n"
                       f"\u274c *Pending:* {pending_text}\n\n"
                       f"Lock your team now! \U0001f449 {APP_BASE_URL}")

                send_group(msg, mentions=pending_mentions)
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
        print(f"    Randomizer: only {len(players_pool)} players in playing XI, need 11. Will retry.")
        return None

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
            auto_picked.append({
                "name": name,
                "phone": user.get("phone", "") if user else "",
            })
            print(f"    Randomizer: auto-picked team for {name}")
        except Exception as e:
            # Duplicate key = already has a team (race condition)
            print(f"    Randomizer: skip {uid} — {e}")

    if auto_picked:
        names, mentions = render_user_refs(auto_picked)
        send_group(
            f"\U0001f3b2 *Auto-picked teams* for: {names}\n\n"
            f"Missed the deadline — random team from playing XI assigned!",
            mentions=mentions,
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
    alert_mentions = []

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
                label, phone = mention_entry(user_name, user.get("phone", ""))
                if phone:
                    alert_mentions.append(phone)
                edit_alerts.append(f"\u26a0\ufe0f *{label}*: Replace {names_str}")

        if edit_alerts:
            msg_parts.append("\u2757 *Edit your team — these players are NOT playing:*\n")
            msg_parts.extend(edit_alerts)
            msg_parts.append(f"\n\U0001f449 {APP_BASE_URL}/")
        else:
            msg_parts.append("\u2705 All submitted teams have only playing XI players!")

    msg = "\n".join(msg_parts)
    send_group(msg, mentions=alert_mentions)
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
                            send_dm("917567838028", im_msg)
                except Exception as im_err:
                    print(f"  Infinity Max early-submit error: {im_err}")
        except Exception as e:
            print(f"  Infinity Max early-submit scan error: {e}")

        # 3a. For matches with playingXI: send squad announcement + auto-generate missing teams
        try:
            live_matches = list(db.matches.find({
                "status": {"$in": ["upcoming", "toss_done", "live"]},
                "playingXI.team1": {"$exists": True, "$ne": []},
                "playingXI.team2": {"$exists": True, "$ne": []},
            }))
            for lm in live_matches:
                # 3a-i. Send squad announcement (once per match)
                try:
                    send_squad_announcement(db, lm, state)
                except Exception as e:
                    print(f"  Squad announcement error: {e}")

                # ── Deadline gate: everything below only runs AFTER deadline ──
                deadline = lm.get("deadline") or (lm["scheduledAt"] + timedelta(minutes=30))
                dl_utc = deadline if deadline.tzinfo else deadline.replace(tzinfo=timezone.utc)
                now_utc = datetime.now(timezone.utc)
                if now_utc < dl_utc:
                    print(f"  Deadline not passed yet — skipping Infinity Max + randomizer")
                    continue

                # 3a-ii. Infinity Max smart team builder (runs AFTER deadline)
                try:
                    im_result = auto_build_and_submit(db, lm, state)
                    if im_result:
                        im_msg = build_team_summary_message(im_result, lm)
                        if im_msg:
                            send_dm("917567838028", im_msg)
                except Exception as im_err:
                    print(f"  Infinity Max builder error: {im_err}")

                # 3a-iii. Auto-generate teams for users who missed deadline
                rando_key = f"{lm['_id']}_randomized"
                if state.get("last_dm", {}).get(rando_key):
                    continue
                auto_picked = auto_generate_missing_teams(db, lm)
                if auto_picked is not None:
                    # Mark done only if pool was sufficient (list returned, even if empty = everyone submitted)
                    # An empty list means everyone already had teams — safe to stop.
                    # None means pool < 11 players — retry next cycle when full XI arrives.
                    state.setdefault("last_dm", {})[rando_key] = True
        except Exception as e:
            print(f"  Randomizer error: {e}")


        # Build player name map once for ESPN dot ball lookups
        _all_players = list(db.players.find({}))
        _pbn = {}
        for _p in _all_players:
            _n = _p["name"].strip().lower()
            _pbn[_n] = _p
            _parts = _n.split()
            if len(_parts) > 1:
                _pbn[_parts[-1]] = _p
            for _a in _p.get("aliases", []):
                _ac = _a.strip().lower()
                _pbn[_ac] = _p
                _ap = _ac.split()
                if len(_ap) > 1:
                    _pbn[_ap[-1]] = _p

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

                # 7b. Fetch dot balls from ESPN for completed matches
                if scorecard.get("is_complete"):
                    try:
                        # Re-fetch match to get updated status
                        fresh_match = db.matches.find_one({"_id": result["match"]["_id"]})
                        if fresh_match:
                            update_dot_balls_from_espn(db, fresh_match, _pbn)
                    except Exception as espn_err:
                        print(f"    ESPN dot ball error: {espn_err}")

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
