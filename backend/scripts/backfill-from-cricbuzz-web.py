#!/usr/bin/env python3
"""
Backfill lbwBowledWickets + fielding stats from Cricbuzz web scorecards.

Cricbuzz embeds RSC payload in the HTML containing the FULL scorecard with
outDesc (dismissal text like "c Axar Patel b Mukesh Kumar"), bowlerId,
fielderId1/2/3, and wicketCode for every dismissal. This works for completed
matches where the live RSC API returns empty data.

This script:
1. Scrapes each completed match's Cricbuzz scorecard page
2. Extracts all dismissal data from embedded RSC payload
3. Parses bowler/fielder NAMES from outDesc text
4. Counts per bowler: lbwBowledWickets (LBW + bowled dismissals)
5. Counts per fielder: catches, stumpings, run outs (direct/indirect)
6. Updates playerperformances in MongoDB

Usage:
  python3 backfill-from-cricbuzz-web.py          # dry-run
  python3 backfill-from-cricbuzz-web.py --apply  # apply changes
"""
import os, sys, re, time
import requests

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

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0.0.0 Safari/537.36"
}

TEAM_SLUG = {
    "CSK": "csk", "MI": "mi", "RCB": "rcb", "KKR": "kkr",
    "RR": "rr", "DC": "dc", "SRH": "srh", "PBKS": "pbks",
    "LSG": "lsg", "GT": "gt",
}


# ─── Parse dismissals from Cricbuzz HTML ───
def extract_dismissals_from_page(html):
    """Extract all batting dismissals from Cricbuzz RSC payload embedded in HTML."""
    pattern = (
        r'\\\\?"outDesc\\\\?":\\\\?"([^"\\]+?)\\\\?"'
        r'.*?\\\\?"bowlerId\\\\?":(\d+)'
        r'.*?\\\\?"fielderId1\\\\?":(\d+)'
        r'.*?\\\\?"fielderId2\\\\?":(\d+)'
        r'.*?\\\\?"fielderId3\\\\?":(\d+)'
        r'.*?\\\\?"wicketCode\\\\?":\\\\?"([^"\\]*?)\\\\?"'
    )

    matches = re.findall(pattern, html)

    # Deduplicate (page renders scorecard twice: mobile + desktop)
    seen = set()
    results = []
    for out_desc, bowler_id, f1, f2, f3, wicket_code in matches:
        key = (out_desc, bowler_id)
        if key not in seen:
            seen.add(key)
            results.append({
                "outDesc": out_desc,
                "bowlerId": int(bowler_id),
                "fielderId1": int(f1),
                "fielderId2": int(f2),
                "fielderId3": int(f3),
                "wicketCode": wicket_code.upper().strip(),
            })
    return results


def parse_names_from_desc(out_desc, wicket_code):
    """Parse bowler and fielder names from dismissal text.

    Examples:
      "c Axar Patel b Mukesh Kumar" → bowler="Mukesh Kumar", fielder="Axar Patel"
      "lbw b Lungi Ngidi"           → bowler="Lungi Ngidi", fielder=None
      "b Jasprit Bumrah"            → bowler="Jasprit Bumrah", fielder=None
      "c and b Mukesh Kumar"        → bowler="Mukesh Kumar", fielder="Mukesh Kumar"
      "st KL Rahul b Axar Patel"    → bowler="Axar Patel", fielder="KL Rahul"
      "run out (Jasprit Bumrah)"    → bowler=None, fielder="Jasprit Bumrah"
      "run out (Bumrah/Chahar)"     → bowler=None, fielders=["Bumrah","Chahar"]
    """
    desc = out_desc.strip()
    bowler_name = None
    fielder_names = []

    if wicket_code in ("LBW", "BOWLED"):
        # "lbw b BOWLER" or "b BOWLER"
        m = re.search(r'b\s+(.+)', desc, re.I)
        if m:
            bowler_name = m.group(1).strip()

    elif wicket_code == "CAUGHTBOWLED":
        # "c and b BOWLER"
        m = re.search(r'c\s+and\s+b\s+(.+)', desc, re.I)
        if m:
            bowler_name = m.group(1).strip()
            fielder_names = [bowler_name]  # bowler = catcher

    elif wicket_code == "CAUGHT":
        # "c FIELDER b BOWLER"
        m = re.search(r'c\s+(.+?)\s+b\s+(.+)', desc, re.I)
        if m:
            fielder_names = [m.group(1).strip()]
            bowler_name = m.group(2).strip()

    elif wicket_code == "STUMPED":
        # "st KEEPER b BOWLER"
        m = re.search(r'st\s+(.+?)\s+b\s+(.+)', desc, re.I)
        if m:
            fielder_names = [m.group(1).strip()]
            bowler_name = m.group(2).strip()

    elif wicket_code == "RUNOUT":
        # "run out (FIELDER)" or "run out (F1/F2)"
        m = re.search(r'run\s+out\s*\(([^)]+)\)', desc, re.I)
        if m:
            names = m.group(1).strip()
            # Split by / for multiple fielders
            fielder_names = [n.strip() for n in names.split("/") if n.strip()]

    return bowler_name, fielder_names


def fetch_scorecard(cb_match_id, t1, t2):
    """Fetch Cricbuzz scorecard page and extract dismissals."""
    s1 = TEAM_SLUG.get(t1, t1.lower())
    s2 = TEAM_SLUG.get(t2, t2.lower())

    urls = [
        f"https://www.cricbuzz.com/live-cricket-scorecard/{cb_match_id}/{s1}-vs-{s2}-indian-premier-league-2026",
        f"https://www.cricbuzz.com/live-cricket-scorecard/{cb_match_id}",
    ]

    for url in urls:
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            if r.status_code == 200 and len(r.text) > 10000:
                dismissals = extract_dismissals_from_page(r.text)
                if dismissals:
                    return dismissals
        except Exception as e:
            print(f"  Error fetching {url}: {e}")
    return []


# ─── Build player name map ───
players = list(db.players.find({}))
pbn = {}  # name → player doc
for p in players:
    n = p["name"].strip().lower()
    pbn[n] = p
    parts = n.split()
    if len(parts) > 1:
        # Store by last name (only if not ambiguous — overwrite is fine, last match wins)
        pbn[parts[-1]] = p
    for a in p.get("aliases", []):
        pbn[a.strip().lower()] = p


def find_player(name):
    """Find a player by name (fuzzy matching)."""
    if not name:
        return None
    clean = name.strip().lower()
    # Remove common suffixes like (c) or (wk)
    clean = re.sub(r'\s*\([^)]*\)\s*$', '', clean).strip()

    if clean in pbn:
        return pbn[clean]
    # Try last name
    parts = clean.split()
    last = parts[-1] if parts else ""
    if last and last in pbn:
        return pbn[last]
    # Substring match on last name
    for key, p in pbn.items():
        if last and last in key:
            return p
    return None


# ─── Main ───
completed = list(db.matches.find({"status": "completed"}))
print(f"{len(completed)} completed matches\n")

total_updates = 0
not_found_names = set()

for match in completed:
    t1, t2 = match["team1"], match["team2"]
    match_id = match["_id"]
    cb_match_id = match.get("cricApiMatchId")

    if not cb_match_id:
        print(f"{t1} vs {t2}: No Cricbuzz match ID — skipping")
        continue

    print(f"{'='*50}")
    print(f"{t1} vs {t2} (CB {cb_match_id}):")

    dismissals = fetch_scorecard(cb_match_id, t1, t2)
    if not dismissals:
        print("  No dismissal data found in page")
        continue

    # Filter out non-dismissals
    real_dismissals = [d for d in dismissals if d["wicketCode"] and d["wicketCode"] not in ("", "NOTOUT")]
    print(f"  Found {len(real_dismissals)} dismissals (out of {len(dismissals)} entries)")

    # Count stats per player name
    lbw_bowled_by_name = {}   # bowler_name → count
    catches_by_name = {}      # fielder_name → count
    stumpings_by_name = {}    # keeper_name → count
    runout_direct_by_name = {}
    runout_indirect_by_name = {}

    for d in real_dismissals:
        code = d["wicketCode"]
        bowler_name, fielder_names = parse_names_from_desc(d["outDesc"], code)

        # LBW/Bowled → count for bowler
        if code in ("LBW", "BOWLED") and bowler_name:
            lbw_bowled_by_name[bowler_name] = lbw_bowled_by_name.get(bowler_name, 0) + 1

        # Catches
        if code in ("CAUGHT", "CAUGHTBOWLED") and fielder_names:
            for fn in fielder_names:
                catches_by_name[fn] = catches_by_name.get(fn, 0) + 1

        # Stumpings
        if code == "STUMPED" and fielder_names:
            for fn in fielder_names:
                stumpings_by_name[fn] = stumpings_by_name.get(fn, 0) + 1

        # Run outs
        if code == "RUNOUT" and fielder_names:
            if len(fielder_names) == 1:
                # Single fielder → direct run out
                runout_direct_by_name[fielder_names[0]] = runout_direct_by_name.get(fielder_names[0], 0) + 1
            else:
                # Multiple fielders → all indirect
                for fn in fielder_names:
                    runout_indirect_by_name[fn] = runout_indirect_by_name.get(fn, 0) + 1

    # ─── Apply lbwBowledWickets ───
    if lbw_bowled_by_name:
        print(f"\n  LBW/Bowled wickets:")
        for name, count in lbw_bowled_by_name.items():
            player = find_player(name)
            if not player:
                print(f"    {name}: {count} lbw/bowled — PLAYER NOT FOUND")
                not_found_names.add(name)
                continue

            perf = db.playerperformances.find_one({
                "playerId": player["_id"],
                "matchId": match_id,
                "oversBowled": {"$gt": 0}
            })
            if not perf:
                print(f"    {name}: {count} lbw/bowled — no bowling perf")
                continue

            current = perf.get("lbwBowledWickets", 0)
            if current != count:
                print(f"    {'[DRY] ' if not APPLY else ''}{player['name']}: lbwBowledWickets {current} → {count}")
                if APPLY:
                    db.playerperformances.update_one({"_id": perf["_id"]}, {"$set": {"lbwBowledWickets": count}})
                total_updates += 1
            else:
                print(f"    {player['name']}: already {count} ✓")
    else:
        print(f"\n  No LBW/Bowled wickets in this match")

    # ─── Apply catches ───
    if catches_by_name:
        print(f"\n  Catches:")
        for name, count in catches_by_name.items():
            player = find_player(name)
            if not player:
                print(f"    {name}: {count} catches — PLAYER NOT FOUND")
                not_found_names.add(name)
                continue

            perf = db.playerperformances.find_one({
                "playerId": player["_id"],
                "matchId": match_id,
            })
            if not perf:
                print(f"    {name}: {count} catches — no performance record")
                continue

            current = perf.get("catches", 0)
            if current != count:
                print(f"    {'[DRY] ' if not APPLY else ''}{player['name']}: catches {current} → {count}")
                if APPLY:
                    db.playerperformances.update_one({"_id": perf["_id"]}, {"$set": {"catches": count}})
                total_updates += 1
            else:
                print(f"    {player['name']}: already {count} ✓")

    # ─── Apply stumpings ───
    if stumpings_by_name:
        print(f"\n  Stumpings:")
        for name, count in stumpings_by_name.items():
            player = find_player(name)
            if not player:
                print(f"    {name}: {count} stumpings — PLAYER NOT FOUND")
                not_found_names.add(name)
                continue

            perf = db.playerperformances.find_one({
                "playerId": player["_id"],
                "matchId": match_id,
            })
            if not perf:
                continue

            current = perf.get("stumpings", 0)
            if current != count:
                print(f"    {'[DRY] ' if not APPLY else ''}{player['name']}: stumpings {current} → {count}")
                if APPLY:
                    db.playerperformances.update_one({"_id": perf["_id"]}, {"$set": {"stumpings": count}})
                total_updates += 1
            else:
                print(f"    {player['name']}: already {count} ✓")

    # ─── Apply run outs ───
    if runout_direct_by_name or runout_indirect_by_name:
        print(f"\n  Run Outs:")
        for name, count in runout_direct_by_name.items():
            player = find_player(name)
            if not player:
                print(f"    {name}: {count} direct run outs — PLAYER NOT FOUND")
                not_found_names.add(name)
                continue

            perf = db.playerperformances.find_one({
                "playerId": player["_id"],
                "matchId": match_id,
            })
            if not perf:
                continue

            current = perf.get("runOutDirect", 0)
            if current != count:
                print(f"    {'[DRY] ' if not APPLY else ''}{player['name']}: runOutDirect {current} → {count}")
                if APPLY:
                    db.playerperformances.update_one({"_id": perf["_id"]}, {"$set": {"runOutDirect": count}})
                total_updates += 1

        for name, count in runout_indirect_by_name.items():
            player = find_player(name)
            if not player:
                print(f"    {name}: {count} indirect run outs — PLAYER NOT FOUND")
                not_found_names.add(name)
                continue

            perf = db.playerperformances.find_one({
                "playerId": player["_id"],
                "matchId": match_id,
            })
            if not perf:
                continue

            current = perf.get("runOutIndirect", 0)
            if current != count:
                print(f"    {'[DRY] ' if not APPLY else ''}{player['name']}: runOutIndirect {current} → {count}")
                if APPLY:
                    db.playerperformances.update_one({"_id": perf["_id"]}, {"$set": {"runOutIndirect": count}})
                total_updates += 1

    # Pause between requests to be polite
    time.sleep(2)

print(f"\n{'='*50}")
if not_found_names:
    print(f"Players NOT FOUND: {not_found_names}")
print(f"Total updates needed: {total_updates}")
print(f"{'DRY RUN — pass --apply to make changes' if not APPLY else 'ALL CHANGES APPLIED'}")
print()
print("NEXT STEP: After --apply, run:")
print("  node recompute_fantasy_scores.js --apply")
print("to recalculate fantasyPoints and team totals.")
client.close()
