#!/usr/bin/env python3
"""
Infinity Max Brain — Smart Fantasy Team Auto-Builder

Analyzes player form, venue stats, role value, and credit efficiency
to build an optimal fantasy team for Infinity Max before each match deadline.

Also predicts match winner based on team strength analysis.

Designed to be called from ipl-scraper.py every cron cycle.
"""
import random
from datetime import datetime, timezone, timedelta
from bson import ObjectId

# Infinity Max user ID in MongoDB
INFINITY_MAX_USER_ID = ObjectId("69ce725ba581ac3cd041b056")
IST = timezone(timedelta(hours=5, minutes=30))

# ─── Team Composition Constraints ───
BUDGET = 100
MAX_FRANCHISE = 7
# Role bounds match backend validation: teams.controller.js validateTeam()
# WK: 1-4, BAT: 3-6 (WK counts towards BAT total), AR: 1-4, BOWL: 3-6
ROLE_BOUNDS = {"WK": (1, 4), "BAT": (1, 6), "AR": (1, 4), "BOWL": (2, 6)}
# WK + BAT combined must be 3-6 (the backend checks this)
BAT_COMBINED_MIN = 3
BAT_COMBINED_MAX = 6
TEAM_SIZE = 11

# ─── Venue Batting Conditions (higher = better for batting) ───
# Based on historical IPL venue data — pitch type scoring
VENUE_BATTING_BIAS = {
    # High-scoring venues (batting-friendly)
    "chinnaswamy": 0.7, "wankhede": 0.65, "brabourne": 0.6,
    "de silva": 0.6, "bengaluru": 0.7, "mumbai": 0.65,
    "jaipur": 0.55, "sawai": 0.55,
    # Balanced venues
    "eden gardens": 0.5, "kolkata": 0.5, "mohali": 0.5,
    "dharamsala": 0.5, "lucknow": 0.5, "ekana": 0.5,
    "narendra modi": 0.45, "ahmedabad": 0.45,
    # Bowling-friendly venues
    "chepauk": 0.35, "chennai": 0.35, "ma chidambaram": 0.35,
    "arun jaitley": 0.4, "feroz shah": 0.4, "delhi": 0.4,
    "uppal": 0.4, "hyderabad": 0.4, "rajiv gandhi": 0.4,
}


def get_venue_bias(venue_str):
    """Return batting bias (0-1) for a venue. Higher = more batting-friendly."""
    if not venue_str:
        return 0.5
    venue_lower = venue_str.lower()
    for key, bias in VENUE_BATTING_BIAS.items():
        if key in venue_lower:
            return bias
    return 0.5  # default balanced


def get_player_form(db, player_id, num_matches=5):
    """
    Get a player's recent fantasy points from last N completed matches.
    Returns: { avg_pts, matches_played, trend, best, worst, consistency }
    """
    perfs = list(db.playerperformances.aggregate([
        {"$match": {"playerId": player_id}},
        {"$lookup": {
            "from": "matches",
            "localField": "matchId",
            "foreignField": "_id",
            "as": "match"
        }},
        {"$unwind": "$match"},
        {"$match": {"match.status": "completed"}},
        {"$sort": {"match.scheduledAt": -1}},
        {"$limit": num_matches},
        {"$project": {
            "fantasyPoints": 1,
            "runs": 1,
            "wickets": 1,
            "catches": 1,
            "oversBowled": 1,
            "didBat": 1,
        }}
    ]))

    if not perfs:
        return {"avg_pts": 0, "matches_played": 0, "trend": 0, "best": 0, "worst": 0, "consistency": 0}

    points = [p.get("fantasyPoints", 0) for p in perfs]
    avg = sum(points) / len(points)
    best = max(points)
    worst = min(points)

    # Trend: positive if recent > older, negative if declining
    # Weight recent matches more: [1.5, 1.3, 1.1, 0.9, 0.7]
    trend = 0
    if len(points) >= 3:
        recent_avg = sum(points[:2]) / 2  # last 2
        older_avg = sum(points[2:]) / len(points[2:])  # older ones
        trend = recent_avg - older_avg

    # Consistency: inverse of standard deviation (higher = more consistent)
    if len(points) >= 2:
        mean = avg
        variance = sum((p - mean) ** 2 for p in points) / len(points)
        std_dev = variance ** 0.5
        consistency = max(0, 100 - std_dev * 2)  # normalize
    else:
        consistency = 50

    return {
        "avg_pts": round(avg, 1),
        "matches_played": len(perfs),
        "trend": round(trend, 1),
        "best": round(best, 1),
        "worst": round(worst, 1),
        "consistency": round(consistency, 1),
    }


def score_player(player, form, venue_bias):
    """
    Score a player for selection. Higher = better pick.

    Factors:
    1. Recent form (average fantasy points) — 40% weight
    2. Trend (improving vs declining) — 15% weight
    3. Role value (all-rounders > pure roles) — 15% weight
    4. Credits efficiency (points per credit) — 15% weight
    5. Venue fit (batters on batting pitches, bowlers on bowling pitches) — 10% weight
    6. Consistency — 5% weight
    """
    role = player.get("role", "BAT")
    credits = player.get("credits", 8)

    # 1. Form score (avg points, scaled to 0-100)
    # For players with no data, use credit-based estimate: higher credits = higher expected output
    if form["avg_pts"] > 0:
        form_score = min(form["avg_pts"] * 1.5, 100)
    else:
        # No form data — estimate based on credits (8cr player ≈ 25-30 pts, 10cr ≈ 35-40)
        form_score = credits * 3.5  # 5cr→17.5, 8cr→28, 10cr→35

    # 2. Trend bonus/penalty
    trend_score = max(min(form["trend"] * 3, 30), -20)

    # 3. Role value — all-rounders contribute in both batting and bowling
    role_value = {"WK": 55, "BAT": 50, "AR": 70, "BOWL": 50}.get(role, 50)

    # 4. Credits efficiency — higher points per credit = better value
    if form["avg_pts"] > 0 and credits > 0:
        efficiency = (form["avg_pts"] / credits) * 10
    else:
        # Without data, assume average output — slight premium for mid-credit players
        efficiency = 3.0  # neutral baseline

    # 5. Venue fit
    venue_score = 0
    if role in ("BAT", "WK"):
        venue_score = venue_bias * 20  # batters benefit from batting pitches
    elif role == "BOWL":
        venue_score = (1 - venue_bias) * 20  # bowlers benefit from bowling pitches
    else:  # AR
        venue_score = 10  # all-rounders always useful

    # 6. Consistency
    consistency_score = form["consistency"] * 0.1

    # Weighted total
    total = (
        form_score * 0.40 +
        trend_score * 0.15 +
        role_value * 0.15 +
        efficiency * 0.15 +
        venue_score * 0.10 +
        consistency_score * 0.05
    )

    # Slight penalty for zero-data players (but not too harsh — early season everyone has 0)
    if form["matches_played"] == 0:
        total *= 0.85  # 15% penalty, not 40%

    return round(total, 2)


def build_smart_team(players_pool, player_scores):
    """
    Build the best possible team of 11 from the playing 22.

    Strategy:
    1. Sort all players by score (descending)
    2. Greedily pick the best players while respecting constraints
    3. Use backtracking if greedy fails

    Returns: (team_11, captain, vice_captain) or None
    """
    # Sort by score descending
    scored_players = [(p, player_scores.get(str(p["_id"]), 0)) for p in players_pool]
    scored_players.sort(key=lambda x: x[1], reverse=True)

    # Check available roles in pool
    pool_roles = {}
    for p in players_pool:
        r = p.get("role", "BAT")
        pool_roles[r] = pool_roles.get(r, 0) + 1

    # Adjust minimums if pool can't satisfy them
    effective_bounds = dict(ROLE_BOUNDS)
    for role, (mn, mx) in ROLE_BOUNDS.items():
        available = pool_roles.get(role, 0)
        if available < mn:
            # Relax minimum to what's available
            effective_bounds[role] = (available, mx)

    # Try multiple strategies with slight randomization for robustness
    best_team = None
    best_total_score = -1

    for attempt in range(50):
        team = []
        credits_used = 0
        role_counts = {"WK": 0, "BAT": 0, "AR": 0, "BOWL": 0}
        franchise_counts = {}
        picked_ids = set()

        # On attempt 0, use pure greedy. On others, add randomization
        if attempt == 0:
            candidates = list(scored_players)
        else:
            # Shuffle within score tiers (±5 score points)
            candidates = list(scored_players)
            # Add small random noise to break ties
            candidates = [(p, s + random.uniform(-3, 3)) for p, s in candidates]
            candidates.sort(key=lambda x: x[1], reverse=True)

        # Phase 1: ensure minimums are met
        # Pick best available for each role minimum
        for role, (mn, _) in effective_bounds.items():
            role_candidates = [(p, s) for p, s in candidates if p.get("role") == role and str(p["_id"]) not in picked_ids]
            for p, s in role_candidates[:mn]:
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

        # Phase 2: fill remaining spots with best available
        remaining = [(p, s) for p, s in candidates if str(p["_id"]) not in picked_ids]
        for p, s in remaining:
            if len(team) >= TEAM_SIZE:
                break
            role = p.get("role", "BAT")
            _, mx = effective_bounds.get(role, (0, 6))
            if role_counts.get(role, 0) >= mx:
                continue
            fr = p.get("franchise", "")
            if franchise_counts.get(fr, 0) >= MAX_FRANCHISE:
                continue
            if credits_used + p.get("credits", 8) > BUDGET:
                continue

            # Check WK+BAT combined constraint
            test_wk = role_counts.get("WK", 0) + (1 if role == "WK" else 0)
            test_bat = role_counts.get("BAT", 0) + (1 if role == "BAT" else 0)
            if test_wk + test_bat > BAT_COMBINED_MAX:
                continue

            team.append(p)
            picked_ids.add(str(p["_id"]))
            credits_used += p.get("credits", 8)
            role_counts[role] = role_counts.get(role, 0) + 1
            franchise_counts[fr] = franchise_counts.get(fr, 0) + 1

        if len(team) != TEAM_SIZE:
            continue

        # Validate WK+BAT combined
        bat_total = role_counts.get("WK", 0) + role_counts.get("BAT", 0)
        if bat_total < BAT_COMBINED_MIN or bat_total > BAT_COMBINED_MAX:
            continue

        # Calculate total team score
        total_score = sum(player_scores.get(str(p["_id"]), 0) for p in team)
        if total_score > best_total_score:
            best_total_score = total_score
            best_team = list(team)

    if not best_team:
        return None

    # Pick Captain and Vice-Captain: top 2 scorers in the team
    team_with_scores = [(p, player_scores.get(str(p["_id"]), 0)) for p in best_team]
    team_with_scores.sort(key=lambda x: x[1], reverse=True)

    captain = team_with_scores[0][0]
    vice_captain = team_with_scores[1][0]

    return best_team, captain, vice_captain


def predict_winner(db, match, players_pool, player_scores):
    """
    Predict match winner based on team strength analysis.
    Compare average player scores for each franchise.
    """
    t1 = match.get("team1", "")
    t2 = match.get("team2", "")

    t1_scores = []
    t2_scores = []

    for p in players_pool:
        score = player_scores.get(str(p["_id"]), 0)
        fr = p.get("franchise", "")
        if fr == t1:
            t1_scores.append(score)
        elif fr == t2:
            t2_scores.append(score)

    t1_avg = sum(t1_scores) / len(t1_scores) if t1_scores else 0
    t2_avg = sum(t2_scores) / len(t2_scores) if t2_scores else 0

    # Also factor in venue — home advantage approximation
    venue = match.get("venue", "")
    venue_bias = get_venue_bias(venue)

    # Simple heuristic: higher average player form = likely winner
    # Add small random factor to avoid always picking same team
    t1_strength = t1_avg + random.uniform(-2, 2)
    t2_strength = t2_avg + random.uniform(-2, 2)

    winner = t1 if t1_strength >= t2_strength else t2
    confidence = abs(t1_strength - t2_strength)

    return winner, round(confidence, 1)


def auto_build_and_submit(db, match, state):
    """
    Main entry point: build and submit Infinity Max's team for a match.

    Called from scraper when:
    - Match is upcoming
    - Deadline is 30-60 min away (after toss, playingXI available)
    - Infinity Max hasn't submitted yet

    Returns: dict with team details or None
    """
    match_id = match["_id"]
    state_key = f"{match_id}_infinity_max_submitted"

    # Already submitted?
    if state.get("last_dm", {}).get(state_key):
        return None

    # Check if Infinity Max already has a team
    existing = db.fantasyteams.find_one({
        "userId": INFINITY_MAX_USER_ID,
        "matchId": match_id
    })
    if existing:
        state.setdefault("last_dm", {})[state_key] = True
        return None

    # Get playing XI
    playing_xi = match.get("playingXI", {})
    team1_ids = playing_xi.get("team1", [])
    team2_ids = playing_xi.get("team2", [])

    if not team1_ids or not team2_ids:
        print(f"    [Infinity Max] No playingXI yet for {match.get('team1')} vs {match.get('team2')}")
        return None

    # Get player documents
    all_player_ids = list(team1_ids) + list(team2_ids)
    players_pool = list(db.players.find({"_id": {"$in": all_player_ids}, "isActive": True}))

    if len(players_pool) < 11:
        print(f"    [Infinity Max] Only {len(players_pool)} active players, need 11")
        return None

    venue = match.get("venue", "")
    venue_bias = get_venue_bias(venue)

    print(f"    [Infinity Max] Analyzing {len(players_pool)} players for {match.get('team1')} vs {match.get('team2')}")
    print(f"    [Infinity Max] Venue: {venue} (batting bias: {venue_bias})")

    # Score each player
    player_scores = {}
    player_forms = {}
    for p in players_pool:
        form = get_player_form(db, p["_id"])
        score = score_player(p, form, venue_bias)
        player_scores[str(p["_id"])] = score
        player_forms[str(p["_id"])] = form

    # Sort and log top picks
    sorted_scores = sorted(player_scores.items(), key=lambda x: x[1], reverse=True)
    print(f"    [Infinity Max] Top 5 picks:")
    for pid, sc in sorted_scores[:5]:
        player = next((p for p in players_pool if str(p["_id"]) == pid), None)
        form = player_forms.get(pid, {})
        if player:
            print(f"      {player['name']} ({player['role']}/{player['franchise']}) "
                  f"— Score: {sc}, Avg: {form.get('avg_pts', 0)}, Trend: {form.get('trend', 0)}")

    # Build team
    result = build_smart_team(players_pool, player_scores)
    if not result:
        print(f"    [Infinity Max] Could not build valid team! Falling back to randomizer...")
        # Fall back to basic random if smart builder fails
        from ipl_scraper_helpers import generate_random_team_fallback
        return None

    team, captain, vice_captain = result
    credits_used = sum(p.get("credits", 8) for p in team)
    role_counts = {}
    for p in team:
        r = p.get("role", "BAT")
        role_counts[r] = role_counts.get(r, 0) + 1

    print(f"    [Infinity Max] Team built!")
    print(f"      Credits: {credits_used}/100")
    print(f"      Roles: {role_counts}")
    print(f"      Captain: {captain['name']} ({captain['role']})")
    print(f"      Vice-Captain: {vice_captain['name']} ({vice_captain['role']})")

    # Submit to MongoDB
    team_doc = {
        "userId": INFINITY_MAX_USER_ID,
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
        db.fantasyteams.insert_one(team_doc)
        print(f"    [Infinity Max] ✅ Team submitted!")
    except Exception as e:
        print(f"    [Infinity Max] ❌ Submission failed: {e}")
        return None

    # Submit prediction
    winner, confidence = predict_winner(db, match, players_pool, player_scores)
    try:
        db.predictions.update_one(
            {"userId": INFINITY_MAX_USER_ID, "matchId": match_id},
            {"$set": {
                "predictedWinner": winner,
                "isCorrect": None,
                "bonusPoints": 0,
                "createdAt": datetime.utcnow(),
                "updatedAt": datetime.utcnow(),
            }},
            upsert=True
        )
        print(f"    [Infinity Max] 🎯 Predicted winner: {winner} (confidence: {confidence})")
    except Exception as e:
        print(f"    [Infinity Max] Prediction error: {e}")

    # Mark as done
    state.setdefault("last_dm", {})[state_key] = True

    return {
        "team": [p["name"] for p in team],
        "captain": captain["name"],
        "vice_captain": vice_captain["name"],
        "credits": credits_used,
        "roles": role_counts,
        "predicted_winner": winner,
    }


def build_team_summary_message(result, match):
    """Build a WhatsApp message announcing Infinity Max's team pick."""
    if not result:
        return None

    t1 = match.get("team1", "?")
    t2 = match.get("team2", "?")
    team_list = "\n".join(f"  {'👑' if p == result['captain'] else '⭐' if p == result['vice_captain'] else '•'} {p}" for p in result["team"])

    msg = (
        f"🤖 *Infinity Max* has entered the arena!\n\n"
        f"📋 *{t1} vs {t2}*\n\n"
        f"{team_list}\n\n"
        f"👑 Captain: {result['captain']}\n"
        f"⭐ Vice-Captain: {result['vice_captain']}\n"
        f"💰 Credits: {result['credits']}/100\n\n"
        f"🎯 Prediction: *{result['predicted_winner']}* wins\n\n"
        f"Let's see if the bot beats you humans! 🔥"
    )
    return msg
