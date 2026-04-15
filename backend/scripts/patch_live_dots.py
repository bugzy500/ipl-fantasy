"""
Apply live dot ball changes to ipl-scraper.py:
1. Add _get_or_set_ipl_match_id() helper
2. Add _fetch_ipl_dots() helper
3. Inject dots into update_match_scores before fantasy point calc
4. Apply Jayesh's PR #28 changes to update_dot_balls_from_ipl
"""

src = open('backend/scripts/ipl-scraper.py').read()

# ── 1. Add two helper functions before update_dot_balls_from_ipl ─────────────

NEW_HELPERS = '''
def _get_or_set_ipl_match_id(db, match):
    """
    Return the IPL official smId for a match.
    If iplMatchId is already set on the match doc, return it immediately.
    Otherwise resolve it from matchlinks by team abbreviations, persist it, and return it.
    Returns None if resolution fails (feed not yet published, team abbr missing, etc.).
    """
    ipl_id = match.get("iplMatchId")
    if ipl_id:
        return ipl_id

    team1 = (match.get("team1") or "").strip()
    team2 = (match.get("team2") or "").strip()
    if not team1 or not team2:
        return None

    try:
        client = _get_ipl_client()
        link = client.find_match_by_teams(team1, team2)
        if not link:
            client.fetch_match_links(force_refresh=True)
            link = client.find_match_by_teams(team1, team2)
        if not link:
            return None

        db.matches.update_one(
            {"_id": match["_id"]},
            {"$set": {"iplMatchId": link.match_id}},
        )
        print(f"    IPL: resolved iplMatchId={link.match_id} for {team1} vs {team2}")
        return link.match_id
    except Exception as e:
        print(f"    IPL: smId resolution failed: {e}")
        return None


def _fetch_ipl_dots(ipl_match_id):
    """
    Fetch dot balls per bowler from IPL official S3 feed.
    Works for live matches (1 innings) and completed matches (2 innings).
    Returns dict: {clean_lowercased_bowler_name: dot_ball_count}
    Returns {} on any fetch failure.
    """
    try:
        client = _get_ipl_client()
        scoreboard = client.fetch_scoreboard(ipl_match_id)
        dots = {}
        for inn in scoreboard.innings:
            for bowler in inn.bowling:
                clean = _clean_ipl_player_name(bowler.name)
                if clean:
                    dots[clean] = dots.get(clean, 0) + bowler.dot_balls
        return dots
    except Exception as e:
        print(f"    IPL: dot ball fetch failed (smId={ipl_match_id}): {e}")
        return {}

'''

src = src.replace(
    'def update_dot_balls_from_ipl(db, match, players_by_name):',
    NEW_HELPERS + 'def update_dot_balls_from_ipl(db, match, players_by_name):'
)

# ── 2. Inject IPL dots into update_match_scores before fantasy calc ──────────

INJECTION = '''    # ── IPL live dot ball injection ──────────────────────────────────────────
    # Cricbuzz never returns dot ball counts — override with IPL official feed.
    # Works for live matches (innings 1 only) and completed matches (both innings).
    # iplMatchId is resolved and persisted here on first call for this match.
    ipl_match_id = _get_or_set_ipl_match_id(db, match)
    if ipl_match_id:
        ipl_dots = _fetch_ipl_dots(ipl_match_id)
        if ipl_dots:
            injected = 0
            for perf in performances.values():
                player = next((p for p in players if str(p["_id"]) == str(perf.get("playerId", ""))), None)
                if not player:
                    continue
                clean = player.get("name", "").strip().lower()
                # Also check aliases
                matched_dots = ipl_dots.get(clean)
                if matched_dots is None:
                    for alias in player.get("aliases", []):
                        matched_dots = ipl_dots.get(alias.strip().lower())
                        if matched_dots is not None:
                            break
                if matched_dots is not None and perf.get("oversBowled", 0) > 0:
                    perf["dotBalls"] = int(matched_dots)
                    injected += 1
            if injected:
                print(f"    IPL dots injected: {injected} bowlers (smId={ipl_match_id})")

    # Upsert performances + calculate fantasy points'''

src = src.replace(
    '    # Upsert performances + calculate fantasy points',
    INJECTION,
    1  # only first occurrence
)

# ── 3. Apply Jayesh's PR #28 changes to update_dot_balls_from_ipl ────────────

# Old guard: skip if iplMatchId IS set (post-match completion marker)
OLD_GUARD = '''    match_id = match["_id"]

    # ── 1. Already processed ─────────────────────────────────────────────
    if match.get("iplMatchId"):
        return 0

    # ── 2. Only completed matches ────────────────────────────────────────
    if match.get("status") != "completed":
        return 0

    # ── 3. Need team abbreviations to look up the IPL smId ───────────────
    team1 = (match.get("team1") or "").strip()
    team2 = (match.get("team2") or "").strip()
    if not team1 or not team2:
        print(f"    IPL: no team abbreviations on match {match_id}; skipping")
        return 0

    # ── 4. Don't clobber existing dot ball data from another source ──────
    # If ESPN patcher (or any prior run) already wrote dots > 0 for any
    # bowler in this match, assume the data is authoritative and skip.
    already_has_dots = db.playerperformances.find_one({'''

# New guard: require iplMatchId to be pre-set (Jayesh PR #28)
NEW_GUARD = '''    match_id = match["_id"]

    # ── 1. Only process if iplMatchId is present on the match doc ────────
    ipl_match_id = match.get("iplMatchId")
    if not ipl_match_id:
        # iplMatchId is pre-set by _get_or_set_ipl_match_id during live polling
        return 0

    # ── 2. Only completed matches ────────────────────────────────────────
    if match.get("status") != "completed":
        return 0

    # ── 3. Check for existing dot ball data ──────────────────────────────
    # Live injection (via update_match_scores) already populated dots.
    # Skip to avoid clobbering correct live data.
    already_has_dots = db.playerperformances.find_one({'''

assert OLD_GUARD in src, "Old guard not found!"
src = src.replace(OLD_GUARD, NEW_GUARD, 1)

# Old: resolve team pair → smId (no longer needed, iplMatchId already set)
OLD_RESOLVE = '''    # ── 5. Resolve team pair → IPL smId via matchlinks ───────────────────
    client = _get_ipl_client()
    try:
        link = client.find_match_by_teams(team1, team2)
        # Matchlinks cache may have been fetched before this match was
        # published to the feed — force a refresh and retry once.
        if not link:
            client.fetch_match_links(force_refresh=True)
            link = client.find_match_by_teams(team1, team2)
        if not link:
            print(f"    IPL: matchlinks has no entry for {team1} vs {team2}; will retry next cycle")
            return 0

        # ── 6. Fetch full scoreboard (both innings) ──────────────────────
        print(f"    Fetching IPL scoreboard (smId {link.match_id}) for {team1} vs {team2}...")
        scoreboard = client.fetch_scoreboard(link.match_id)
    except IPLFeedError as e:
        print(f"    IPL fetch failed: {e} — terminating")
        return 0
    except Exception as e:
        print(f"    IPL unexpected error: {e} — terminating")
        return 0'''

# New: use pre-set iplMatchId directly
NEW_RESOLVE = '''    # ── 4. Fetch scoreboard using pre-set iplMatchId ────────────────────────
    client = _get_ipl_client()
    try:
        print(f"    Fetching IPL scoreboard (iplMatchId={ipl_match_id})...")
        scoreboard = client.fetch_scoreboard(ipl_match_id)
    except IPLFeedError as e:
        print(f"    IPL fetch failed: {e} — terminating")
        return 0
    except Exception as e:
        print(f"    IPL unexpected error: {e} — terminating")
        return 0'''

assert OLD_RESOLVE in src, "Old resolve block not found!"
src = src.replace(OLD_RESOLVE, NEW_RESOLVE, 1)

# Old: stamp iplMatchId at the end (no longer needed — already set)
OLD_STAMP = '''    if updated == 0:
        print(f"    IPL: 0 records updated; not marking iplMatchId")
        return 0

    # ── 10. Persist iplMatchId on the match doc ──────────────────────────
    # Once this is set, guard #1 short-circuits future runs for this match.
    db.matches.update_one(
        {"_id": match_id},
        {"$set": {"iplMatchId": link.match_id}},
    )

    print(f"    IPL dot balls: {updated} bowler(s) patched (smId={link.match_id})")
    return updated

# ─── Main ───'''

NEW_STAMP = '''    if updated == 0:
        print(f"    IPL: 0 records updated")
        return 0

    print(f"    IPL dot balls: {updated} bowler(s) patched (iplMatchId={ipl_match_id})")
    return updated

# ─── Main ───'''

assert OLD_STAMP in src, "Old stamp block not found!"
src = src.replace(OLD_STAMP, NEW_STAMP, 1)

open('backend/scripts/ipl-scraper.py', 'w').write(src)
print("All patches applied successfully.")

# Verify
checks = [
    ('_get_or_set_ipl_match_id', 'helper function added'),
    ('_fetch_ipl_dots', 'dots fetch helper added'),
    ('IPL live dot ball injection', 'injection in update_match_scores'),
    ('ipl_match_id = match.get("iplMatchId")', 'PR #28 guard applied'),
    ('iplMatchId is pre-set by _get_or_set_ipl_match_id', 'PR #28 comment'),
]
content = open('backend/scripts/ipl-scraper.py').read()
for pattern, desc in checks:
    status = 'OK' if pattern in content else 'MISSING'
    print(f"  [{status}] {desc}")
