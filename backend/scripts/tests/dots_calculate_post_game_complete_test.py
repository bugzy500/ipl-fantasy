import requests
import json
import re
from pathlib import Path


def parse_innings_scorecard(raw_text):
    """
    Parse the IPL official S3 feed (iplt20.com / ipl-stats-sports-mechanic) for a
    single innings and return a structured dictionary of batting and bowling stats.

    The S3 feed is JSONP wrapped in `onScoring({...})`. Payload shape:
        {
            "Innings1" | "Innings2": {
                "BattingCard": [ {PlayerName, Runs, Balls, DotBalls, Fours, Sixes, StrikeRate, OutDesc, ...}, ... ],
                "BowlingCard": [ {PlayerName, Overs, Maidens, Runs, Wickets, DotBalls, Economy, ...}, ... ],
                "Extras": {...}, "FallOfWickets": [...], ...
            }
        }

    Returns:
        {
            "innings": "Innings1" | "Innings2",
            "matchId": int,
            "teamId": int,           # batting team id
            "batting": [
                {
                    "playerId": str,
                    "name": str,
                    "runs": int,
                    "balls": int,
                    "dotBalls": int,
                    "fours": int,
                    "sixes": int,
                    "strikeRate": float,
                    "isOut": bool,
                    "outDesc": str,
                    "bowlerName": str,   # dismissing bowler, "" if not out
                },
                ...
            ],
            "bowling": [
                {
                    "playerId": str,
                    "name": str,
                    "overs": float,
                    "maidens": int,
                    "runs": int,
                    "wickets": int,
                    "dotBalls": int,
                    "economy": float,
                    "wides": int,
                    "noBalls": int,
                    "legalBalls": int,
                },
                ...
            ]
        }

    Returns None on parse failure.
    """
    if not raw_text:
        return None

    # Strip JSONP wrapper: onScoring({...}); or onScoring({...})
    start = raw_text.find('(')
    end = raw_text.rfind(')')
    if start == -1 or end == -1 or end <= start:
        return None

    try:
        payload = json.loads(raw_text[start + 1:end])
    except json.JSONDecodeError as e:
        print(f"JSON parse failed: {e}")
        return None

    # Feed can have Innings1, Innings2, or both in the same file.
    # We return whichever is present; if both, we prefer the first found.
    innings_key = None
    for candidate in ("Innings1", "Innings2"):
        if candidate in payload and isinstance(payload[candidate], dict):
            innings_key = candidate
            break
    if not innings_key:
        return None

    inn = payload[innings_key]
    batting_raw = inn.get("BattingCard", []) or []
    bowling_raw = inn.get("BowlingCard", []) or []

    def _to_int(v, default=0):
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return default

    def _to_float(v, default=0.0):
        try:
            return float(v)
        except (TypeError, ValueError):
            return default

    batting = []
    for p in batting_raw:
        out_desc = (p.get("OutDesc") or "").strip()
        # IPL feed uses empty string / "not out" for not-dismissed batters.
        is_out = bool(out_desc) and out_desc.lower() not in ("not out", "notout", "")
        batting.append({
            "playerId": str(p.get("PlayerID", "")),
            "name": (p.get("PlayerName") or "").strip(),
            "runs": _to_int(p.get("Runs")),
            "balls": _to_int(p.get("Balls")),
            "dotBalls": _to_int(p.get("DotBalls")),
            "fours": _to_int(p.get("Fours")),
            "sixes": _to_int(p.get("Sixes")),
            "strikeRate": _to_float(p.get("StrikeRate")),
            "isOut": is_out,
            "outDesc": out_desc,
            "bowlerName": (p.get("BowlerName") or "").strip(),
        })

    bowling = []
    for p in bowling_raw:
        bowling.append({
            "playerId": str(p.get("PlayerID", "")),
            "name": (p.get("PlayerName") or "").strip(),
            "overs": _to_float(p.get("Overs")),
            "maidens": _to_int(p.get("Maidens")),
            "runs": _to_int(p.get("Runs")),
            "wickets": _to_int(p.get("Wickets")),
            "dotBalls": _to_int(p.get("DotBalls")),
            "economy": _to_float(p.get("Economy")),
            "wides": _to_int(p.get("Wides")),
            "noBalls": _to_int(p.get("NoBalls")),
            "legalBalls": _to_int(p.get("TotalLegalBallsBowled")),
        })

    # Try to pick up match/team metadata from the first batter (feed is consistent per innings)
    match_id = 0
    team_id = 0
    if batting_raw:
        match_id = _to_int(batting_raw[0].get("MatchID"))
        team_id = _to_int(batting_raw[0].get("TeamID"))

    return {
        "innings": innings_key,
        "matchId": match_id,
        "teamId": team_id,
        "batting": batting,
        "bowling": bowling,
    }


def get_innings_scoreboard_from_file(file_path):
    """Convenience wrapper: load a saved IPL feed file and return parsed scoreboard dict."""
    with open(file_path, 'r', encoding='utf-8') as f:
        return parse_innings_scorecard(f.read())


def fetch_innings_scoreboard(innings_id):
    """
    Fetch an innings scoreboard live from the IPL S3 feed.
    `innings_id` format: "<matchId>-Innings<1|2>", e.g. "2462-Innings2".
    Returns the same dict shape as parse_innings_scorecard() or None on failure.
    """
    url = f"https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/{innings_id}.js"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code != 200:
            print(f"IPL feed returned {r.status_code} for {innings_id}")
            return None
        return parse_innings_scorecard(r.text)
    except requests.RequestException as e:
        print(f"IPL feed fetch error: {e}")
        return None


def parse_scorecard_from_text(text):
    """
    Extracts batting and bowling stats from the raw IPL feed text using string manipulation.
    Handles data that might be malformed for pure JSON parsing.
    """
    result = {}
    
    # Identify Innings parts manually
    for inn_key in ['Innings1', 'Innings2']:
        pattern = f'"{inn_key}"\s*:\s*{{'
        match = re.search(pattern, text)
        if not match:
            continue
            
        # Extract the content between BattingCard: [...] and BowlingCard: [...]
        # This is more robust than parsing the entire Innings object
        inn_stats = {'batting': [], 'bowling': []}
        
        # Extract BattingCard
        batting_start = text.find('"BattingCard"', match.end())
        if batting_start != -1:
            array_start = text.find('[', batting_start)
            # Find the matching closing bracket for the array
            bracket_count = 0
            array_end = -1
            for i in range(array_start, len(text)):
                if text[i] == '[': bracket_count += 1
                elif text[i] == ']':
                    bracket_count -= 1
                    if bracket_count == 0:
                        array_end = i + 1
                        break
            
            if array_end != -1:
                # Find all objects {} inside this array
                bat_array_text = text[array_start:array_end]
                # Regex to find JSON-like objects in the array
                # This handles potentially malformed entries by isolating individual objects
                obj_matches = re.finditer(r'\{[^{}]*\}', bat_array_text)
                for obj_match in obj_matches:
                    obj_str = obj_match.group(0)
                    # Helper to get field value without full JSON parse
                    def get_field(field, string):
                        f_pattern = f'"{field}"\s*:\s*"([^"]*)"'
                        f_match = re.search(f_pattern, string)
                        if f_match: return f_match.group(1)
                        # Try numeric
                        n_pattern = f'"{field}"\s*:\s*(\d+\.?\d*)'
                        n_match = re.search(n_pattern, string)
                        return n_match.group(1) if n_match else "0"

                    inn_stats['batting'].append({
                        'name': get_field('PlayerName', obj_str) or get_field('BatsManName', obj_str),
                        'runs': int(float(get_field('Runs', obj_str))),
                        'balls': int(float(get_field('Balls', obj_str) or get_field('BallsFaced', obj_str))),
                        'fours': int(float(get_field('Fours', obj_str) or get_field('Bdry4', obj_str))),
                        'sixes': int(float(get_field('Sixes', obj_str) or get_field('Bdry6', obj_str))),
                        'sr': get_field('StrikeRate', obj_str),
                        'outDesc': get_field('OutDesc', obj_str)
                    })
        
        # Extract BowlingCard
        bowling_start = text.find('"BowlingCard"', match.end())
        if bowling_start != -1:
            array_start = text.find('[', bowling_start)
            bracket_count = 0
            array_end = -1
            for i in range(array_start, len(text)):
                if text[i] == '[': bracket_count += 1
                elif text[i] == ']':
                    bracket_count -= 1
                    if bracket_count == 0:
                        array_end = i + 1
                        break
            
            if array_end != -1:
                bowl_array_text = text[array_start:array_end]
                obj_matches = re.finditer(r'\{[^{}]*\}', bowl_array_text)
                for obj_match in obj_matches:
                    obj_str = obj_match.group(0)
                    def get_field(field, string):
                        f_pattern = f'"{field}"\s*:\s*"([^"]*)"'
                        f_match = re.search(f_pattern, string)
                        if f_match: return f_match.group(1)
                        n_pattern = f'"{field}"\s*:\s*(\d+\.?\d*)'
                        n_match = re.search(n_pattern, string)
                        return n_match.group(1) if n_match else "0"

                    inn_stats['bowling'].append({
                        'name': get_field('PlayerName', obj_str) or get_field('BowlerName', obj_str),
                        'overs': get_field('Overs', obj_str),
                        'maidens': int(float(get_field('Maidens', obj_str))),
                        'runs': int(float(get_field('Runs', obj_str) or get_field('RunsConceded', obj_str))),
                        'wickets': int(float(get_field('Wickets', obj_str))),
                        'dotBalls': int(float(get_field('DotBalls', obj_str) or get_field('DotBallsBowled', obj_str))),
                        'economy': get_field('Economy', obj_str) or get_field('EconomyRate', obj_str)
                    })
        
        result[inn_key] = inn_stats
        
    return result if result else None

def get_complete_scoreboard(file_path):
    """
    Reads the file and returns a structured dictionary of batting and bowling stats.
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        scorecard = parse_scorecard_from_text(content)
        return scorecard
    except Exception as e:
        print(f"Error reading/parsing file: {e}")
        return None

def fetch_ipl_stats(innings_id):
    """
    Fetch IPL stats directly from S3
    """
    url = f"https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds/{innings_id}.js"
    
    print(f"Fetching: {url}")
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=10)
        
        if response.status_code == 200:
            text = response.text
            
            # Save to sample_data file
            sample_data_dir = Path(__file__).parent / "sample_data"
            sample_data_dir.mkdir(exist_ok=True)
            output_file = sample_data_dir / "ipl_data_inning_wise.txt"
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(text)
            
            # Parse the text
            scorecard = parse_scorecard_from_text(text)
            return scorecard
        else:
            print(f"❌ Error: Status {response.status_code}")
            return None
            
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

if __name__ == "__main__":
    # Path to the data file
    data_file = Path("d:/WORK/ipl-fantasy-jayesh/backend/scripts/sample_data/ipl-official-website-data.txt")
    
    if data_file.exists():
        print(f"Analyzing file: {data_file}")
        scorecard = get_complete_scoreboard(data_file)
        
        if scorecard:
            # Save the structured output for verification
            output_json = Path("d:/WORK/ipl-fantasy-jayesh/backend/scripts/sample_data/structured_scorecard.json")
            with open(output_json, 'w', encoding='utf-8') as f:
                json.dump(scorecard, f, indent=2)
            
            print(f"✓ Structured scorecard saved to {output_json}")
            
            # Print summary for quick verification
            for inn, data in scorecard.items():
                print(f"\n--- {inn} ---")
                print(f"{'BATTING':<20} | {'R':<3} | {'B':<3} | {'4s':<3} | {'6s':<3} | {'SR':<6}")
                print("-" * 55)
                for b in data['batting']:
                    print(f"{b['name']:<20} | {b['runs']:<3} | {b['balls']:<3} | {b['fours']:<3} | {b['sixes']:<3} | {b['sr']:<6}")
                
                print(f"\n{'BOWLING':<20} | {'O':<4} | {'M':<2} | {'R':<3} | {'W':<2} | {'Dots':<4} | {'Eco':<5}")
                print("-" * 55)
                for b in data['bowling']:
                    print(f"{b['name']:<20} | {b['overs']:<4} | {b['maidens']:<2} | {b['runs']:<3} | {b['wickets']:<2} | {b['dotBalls']:<4} | {b['economy']:<5}")
        else:
            print("❌ Failed to extract scorecard data")
    else:
        print(f"❌ Could not find file at {data_file}")

