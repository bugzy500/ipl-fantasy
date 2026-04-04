#!/usr/bin/env python3
"""
Find & add missing IPL 2026 players.
Scrapes Cricbuzz squad pages for all 10 IPL teams,
compares against MongoDB players collection,
and inserts any missing players.
"""

import re
import json
import sys
from urllib.request import urlopen, Request
from pymongo import MongoClient
from datetime import datetime

# ── Config ────────────────────────────────────────────────────────────────────
def load_env(path="/opt/services/ipl-scraper/.env"):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        print(f"WARN: {path} not found, using env vars")
    return env

env = load_env()
MONGO_URI = env.get("MONGO_URI", "")
if not MONGO_URI:
    import os
    MONGO_URI = os.environ.get("MONGO_URI", "")
if not MONGO_URI:
    print("ERROR: No MONGO_URI found")
    sys.exit(1)

# Extract DB name from URI
db_name = MONGO_URI.rsplit("/", 1)[-1].split("?")[0] if "/" in MONGO_URI else "ipl-fantasy"

client = MongoClient(MONGO_URI)
db = client[db_name]

# ── IPL 2026 Team Squad URLs on Cricbuzz ──────────────────────────────────────
# We'll discover these from the IPL teams page
FRANCHISE_MAP = {
    "Chennai Super Kings": "CSK",
    "Mumbai Indians": "MI",
    "Royal Challengers Bengaluru": "RCB",
    "Royal Challengers Bangalore": "RCB",
    "Kolkata Knight Riders": "KKR",
    "Sunrisers Hyderabad": "SRH",
    "Rajasthan Royals": "RR",
    "Punjab Kings": "PBKS",
    "Delhi Capitals": "DC",
    "Gujarat Titans": "GT",
    "Lucknow Super Giants": "LSG",
}

# Known Cricbuzz IPL 2026 squad page IDs (team page IDs)
# Format: https://www.cricbuzz.com/cricket-team/{team-slug}/{team-id}/players
TEAM_PAGES = {
    "CSK": "https://www.cricbuzz.com/cricket-team/chennai-super-kings/9/players",
    "MI": "https://www.cricbuzz.com/cricket-team/mumbai-indians/10/players",
    "RCB": "https://www.cricbuzz.com/cricket-team/royal-challengers-bengaluru/11/players",
    "KKR": "https://www.cricbuzz.com/cricket-team/kolkata-knight-riders/12/players",
    "SRH": "https://www.cricbuzz.com/cricket-team/sunrisers-hyderabad/255/players",
    "RR": "https://www.cricbuzz.com/cricket-team/rajasthan-royals/13/players",
    "PBKS": "https://www.cricbuzz.com/cricket-team/punjab-kings/14/players",
    "DC": "https://www.cricbuzz.com/cricket-team/delhi-capitals/8/players",
    "GT": "https://www.cricbuzz.com/cricket-team/gujarat-titans/598/players",
    "LSG": "https://www.cricbuzz.com/cricket-team/lucknow-super-giants/597/players",
}

# Role detection from Cricbuzz role text
ROLE_MAP = {
    "batsman": "BAT",
    "batter": "BAT",
    "top-order batter": "BAT",
    "middle-order batter": "BAT",
    "opening batter": "BAT",
    "bowler": "BOWL",
    "pace bowler": "BOWL",
    "spin bowler": "BOWL",
    "fast bowler": "BOWL",
    "medium pacer": "BOWL",
    "left-arm pacer": "BOWL",
    "right-arm pacer": "BOWL",
    "left-arm spinner": "BOWL",
    "right-arm spinner": "BOWL",
    "leg-spinner": "BOWL",
    "off-spinner": "BOWL",
    "allrounder": "AR",
    "all-rounder": "AR",
    "batting allrounder": "AR",
    "bowling allrounder": "AR",
    "wicketkeeper": "WK",
    "wicketkeeper batter": "WK",
    "wicketkeeper-batter": "WK",
    "keeper": "WK",
    "wk-batter": "WK",
}

# Known player roles for common IPL players (fallback)
KNOWN_ROLES = {
    "David Payne": "BOWL",
    "Blessing Muzarabani": "BOWL",
    "Jaydev Unadkat": "BOWL",
    "Yash Dayal": "BOWL",
    "Umran Malik": "BOWL",
    "T Natarajan": "BOWL",
    "Shahbaz Ahmed": "AR",
    "Washington Sundar": "AR",
    "Vijay Shankar": "AR",
    "Venkatesh Iyer": "AR",
    "Rinku Singh": "BAT",
    "Angkrish Raghuvanshi": "BAT",
    "Ramandeep Singh": "AR",
    "Manish Pandey": "BAT",
    "Ajinkya Rahane": "BAT",
    "Anmolpreet Singh": "BAT",
    "Luvnith Sisodia": "WK",
    "KS Bharat": "WK",
    "Sanju Samson": "WK",
    "Ishan Kishan": "WK",
    "Quinton de Kock": "WK",
    "Spencer Johnson": "BOWL",
    "Lockie Ferguson": "BOWL",
    "Trent Boult": "BOWL",
    "Jasprit Bumrah": "BOWL",
    "Mohammed Siraj": "BOWL",
    "Arshdeep Singh": "BOWL",
    "Kagiso Rabada": "BOWL",
    "Anrich Nortje": "BOWL",
    "Marco Jansen": "AR",
    "Sam Curran": "AR",
    "Mitchell Marsh": "AR",
    "Glenn Maxwell": "AR",
    "Moeen Ali": "AR",
    "Andre Russell": "AR",
    "Liam Livingstone": "AR",
    "Hardik Pandya": "AR",
    "Ravindra Jadeja": "AR",
    "Axar Patel": "AR",
    "Sunil Narine": "AR",
}

# Default credits for uncapped/lesser-known players
DEFAULT_CREDITS = 6.0

def fetch_page(url):
    """Fetch a web page with browser-like headers."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    req = Request(url, headers=headers)
    try:
        resp = urlopen(req, timeout=15)
        return resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"  WARN: Failed to fetch {url}: {e}")
        return ""


def extract_players_from_squad_page(html, franchise):
    """Extract player names from Cricbuzz squad/team players page."""
    players = []

    # Method 1: Look for Next.js data chunks (self.__next_f.push patterns)
    next_chunks = re.findall(r'self\.__next_f\.push\(\[1,"([^"]*?)"\]\)', html)
    for chunk in next_chunks:
        # Unescape the JSON string
        try:
            unescaped = chunk.encode().decode('unicode_escape')
        except:
            unescaped = chunk

        # Look for player data patterns
        # Pattern: "name":"PlayerName","role":"Role"
        name_matches = re.findall(r'"name"\s*:\s*"([^"]+)"', unescaped)
        role_matches = re.findall(r'"role"\s*:\s*"([^"]+)"', unescaped)

        for i, name in enumerate(name_matches):
            if len(name) > 2 and not name.startswith("http"):
                role_text = role_matches[i].lower() if i < len(role_matches) else ""
                role = ROLE_MAP.get(role_text, KNOWN_ROLES.get(name, "BAT"))
                players.append({"name": name, "role": role})

    # Method 2: Look for player profile links
    # Pattern: /profiles/12345/player-name
    profile_matches = re.findall(r'/profiles/(\d+)/([a-z0-9-]+)', html)
    seen_ids = set()
    for pid, slug in profile_matches:
        if pid in seen_ids:
            continue
        seen_ids.add(pid)
        # Convert slug to name: "virat-kohli" -> "Virat Kohli"
        name = " ".join(word.capitalize() for word in slug.split("-"))
        if len(name) > 3 and name not in [p["name"] for p in players]:
            role = KNOWN_ROLES.get(name, "BAT")
            players.append({"name": name, "role": role, "cricbuzzId": pid})

    # Method 3: Look for faceImageId patterns (JSON data)
    face_matches = re.findall(r'"faceImageId"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"fullName"\s*:\s*"([^"]+)"', html)
    for fid, short_name, full_name in face_matches:
        if full_name not in [p["name"] for p in players]:
            role = KNOWN_ROLES.get(full_name, KNOWN_ROLES.get(short_name, "BAT"))
            players.append({"name": full_name, "role": role})

    return players


def normalize_name(name):
    """Normalize a player name for comparison."""
    # Remove common prefixes/suffixes
    n = name.strip().lower()
    # Remove dots, extra spaces
    n = re.sub(r'\.', ' ', n)
    n = re.sub(r'\s+', ' ', n)
    return n


def names_match(name1, name2):
    """Check if two player names likely refer to the same person."""
    n1 = normalize_name(name1)
    n2 = normalize_name(name2)

    # Exact match
    if n1 == n2:
        return True

    # Last name match + first initial
    parts1 = n1.split()
    parts2 = n2.split()

    if len(parts1) >= 2 and len(parts2) >= 2:
        # Same last name
        if parts1[-1] == parts2[-1]:
            # First name starts with same letter
            if parts1[0][0] == parts2[0][0]:
                return True

    # One is abbreviation of other: "V Kohli" vs "Virat Kohli"
    if len(parts1) >= 2 and len(parts2) >= 2:
        if parts1[-1] == parts2[-1]:
            if len(parts1[0]) == 1 or len(parts2[0]) == 1:
                return True

    # Check if one name contains the other's last name
    if len(parts1) >= 1 and len(parts2) >= 1:
        if parts1[-1] == parts2[-1] and (len(parts1) == 1 or len(parts2) == 1):
            return True

    return False


def get_existing_players():
    """Get all players currently in the DB."""
    players = list(db.players.find({"isActive": True}))
    return players


def is_player_in_db(name, franchise, existing_players):
    """Check if a player already exists in the DB."""
    for p in existing_players:
        # Check main name
        if names_match(name, p["name"]):
            return True
        # Check aliases
        for alias in p.get("aliases", []):
            if names_match(name, alias):
                return True
    return False


def main():
    existing = get_existing_players()
    print(f"\n{'='*60}")
    print(f"EXISTING PLAYERS IN DB: {len(existing)}")
    print(f"{'='*60}\n")

    # Count per franchise
    franchise_counts = {}
    for p in existing:
        f = p.get("franchise", "UNKNOWN")
        franchise_counts[f] = franchise_counts.get(f, 0) + 1
    for f in sorted(franchise_counts.keys()):
        print(f"  {f}: {franchise_counts[f]} players")

    all_missing = []

    # Also try scraping from match squad pages (more reliable for current season)
    # Get recent matches to find Cricbuzz match IDs
    matches = list(db.matches.find({"cricApiMatchId": {"$exists": True, "$ne": ""}}))
    print(f"\nFound {len(matches)} matches with Cricbuzz IDs")

    squad_urls_tried = set()

    for match in matches:
        cb_id = match.get("cricApiMatchId", "")
        if not cb_id:
            continue

        squad_url = f"https://www.cricbuzz.com/cricket-match-squads/{cb_id}"
        if squad_url in squad_urls_tried:
            continue
        squad_urls_tried.add(squad_url)

        team1 = match.get("team1", "")
        team2 = match.get("team2", "")
        franchise1 = FRANCHISE_MAP.get(team1, team1)
        franchise2 = FRANCHISE_MAP.get(team2, team2)

        # Map common short names
        short_map = {"CSK": "CSK", "MI": "MI", "RCB": "RCB", "KKR": "KKR",
                     "SRH": "SRH", "RR": "RR", "PBKS": "PBKS", "DC": "DC",
                     "GT": "GT", "LSG": "LSG"}
        if franchise1 in short_map:
            pass  # already short
        if franchise2 in short_map:
            pass

        print(f"\nScraping squad: {team1} vs {team2} (CB ID: {cb_id})")
        html = fetch_page(squad_url)
        if not html:
            continue

        # Extract players and try to assign to correct franchise
        # From squad pages, players are usually listed under team headers
        # Try to find team sections

        # Look for JSON data with team info
        # Cricbuzz squad pages often have player data in script tags
        players_found = extract_players_from_squad_page(html, "")

        # Also try direct JSON extraction
        json_matches = re.findall(r'"faceImageId"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"fullName"\s*:\s*"([^"]+)"', html)

        if json_matches:
            print(f"  Found {len(json_matches)} players via JSON pattern")
            for fid, short_name, full_name in json_matches:
                # Determine franchise - check if player exists in DB first
                matched_franchise = None
                for p in existing:
                    if names_match(full_name, p["name"]) or names_match(short_name, p["name"]):
                        matched_franchise = p.get("franchise")
                        break

                if not is_player_in_db(full_name, "", existing):
                    # Try to figure out franchise from context
                    # The JSON data usually lists team1 players first, then team2
                    role = KNOWN_ROLES.get(full_name, KNOWN_ROLES.get(short_name, "BAT"))
                    all_missing.append({
                        "name": full_name,
                        "shortName": short_name,
                        "role": role,
                        "franchise": "UNKNOWN",  # Will resolve later
                        "source": f"squad_{cb_id}",
                        "cricbuzzFaceId": fid,
                    })

        # Try profile link extraction too
        profile_matches = re.findall(r'/profiles/(\d+)/([a-z0-9-]+)', html)
        seen_ids = set()
        for pid, slug in profile_matches:
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            name = " ".join(word.capitalize() for word in slug.split("-"))
            if len(name) > 3 and not is_player_in_db(name, "", existing):
                already_in_missing = any(names_match(name, m["name"]) for m in all_missing)
                if not already_in_missing:
                    role = KNOWN_ROLES.get(name, "BAT")
                    all_missing.append({
                        "name": name,
                        "role": role,
                        "franchise": "UNKNOWN",
                        "source": f"profile_{cb_id}",
                        "cricbuzzId": pid,
                    })

    # Now try team pages for franchise assignment
    print(f"\n{'='*60}")
    print("SCRAPING TEAM PAGES FOR FRANCHISE ASSIGNMENT")
    print(f"{'='*60}\n")

    team_rosters = {}  # franchise -> [player names]

    for franchise, url in TEAM_PAGES.items():
        print(f"Scraping {franchise}: {url}")
        html = fetch_page(url)
        if not html:
            continue

        names_on_page = set()

        # Extract from JSON patterns
        json_matches = re.findall(r'"faceImageId"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"fullName"\s*:\s*"([^"]+)"', html)
        for fid, short_name, full_name in json_matches:
            names_on_page.add(full_name)

        # Extract from profile links
        profile_matches = re.findall(r'/profiles/(\d+)/([a-z0-9-]+)', html)
        seen_ids = set()
        for pid, slug in profile_matches:
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            name = " ".join(word.capitalize() for word in slug.split("-"))
            if len(name) > 3:
                names_on_page.add(name)

        team_rosters[franchise] = list(names_on_page)
        print(f"  Found {len(names_on_page)} player names")

        # Check for missing players
        for name in names_on_page:
            if not is_player_in_db(name, franchise, existing):
                already_in_missing = any(names_match(name, m["name"]) for m in all_missing)
                if already_in_missing:
                    # Update franchise
                    for m in all_missing:
                        if names_match(name, m["name"]):
                            m["franchise"] = franchise
                            break
                else:
                    role = KNOWN_ROLES.get(name, "BAT")
                    all_missing.append({
                        "name": name,
                        "role": role,
                        "franchise": franchise,
                        "source": f"team_page_{franchise}",
                    })

    # Resolve UNKNOWN franchises using team rosters
    for m in all_missing:
        if m["franchise"] == "UNKNOWN":
            for franchise, roster in team_rosters.items():
                for rname in roster:
                    if names_match(m["name"], rname):
                        m["franchise"] = franchise
                        break
                if m["franchise"] != "UNKNOWN":
                    break

    # Deduplicate
    seen_names = set()
    unique_missing = []
    for m in all_missing:
        norm = normalize_name(m["name"])
        if norm not in seen_names:
            seen_names.add(norm)
            unique_missing.append(m)

    # Print results
    print(f"\n{'='*60}")
    print(f"MISSING PLAYERS: {len(unique_missing)}")
    print(f"{'='*60}\n")

    if not unique_missing:
        print("No missing players found!")
        return

    # Group by franchise
    by_franchise = {}
    for m in unique_missing:
        f = m.get("franchise", "UNKNOWN")
        by_franchise.setdefault(f, []).append(m)

    for f in sorted(by_franchise.keys()):
        print(f"\n  {f}:")
        for p in by_franchise[f]:
            print(f"    - {p['name']} ({p['role']}) [source: {p.get('source', '?')}]")

    # Ask before inserting
    still_unknown = [m for m in unique_missing if m["franchise"] == "UNKNOWN"]
    if still_unknown:
        print(f"\n⚠️  {len(still_unknown)} players have UNKNOWN franchise - these will be SKIPPED")
        unique_missing = [m for m in unique_missing if m["franchise"] != "UNKNOWN"]

    if not unique_missing:
        print("No players to insert after removing unknowns.")
        return

    print(f"\n{'='*60}")
    print(f"INSERTING {len(unique_missing)} MISSING PLAYERS")
    print(f"{'='*60}\n")

    inserted = 0
    for p in unique_missing:
        doc = {
            "name": p["name"],
            "franchise": p["franchise"],
            "role": p["role"],
            "credits": DEFAULT_CREDITS,
            "imageUrl": "",
            "aliases": [],
            "isActive": True,
            "createdAt": datetime.utcnow(),
            "updatedAt": datetime.utcnow(),
        }
        # Add short name as alias if we have it
        if p.get("shortName") and p["shortName"] != p["name"]:
            doc["aliases"].append(p["shortName"])

        try:
            result = db.players.insert_one(doc)
            print(f"  ✅ Inserted: {p['name']} ({p['franchise']}, {p['role']}, ₹{DEFAULT_CREDITS}) -> {result.inserted_id}")
            inserted += 1
        except Exception as e:
            print(f"  ❌ Failed: {p['name']}: {e}")

    print(f"\nDone! Inserted {inserted}/{len(unique_missing)} players.")


if __name__ == "__main__":
    main()
