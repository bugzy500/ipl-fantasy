#!/usr/bin/env python3
"""
Fetch actual Playing XI for an IPL match from Cricbuzz.

Usage:
    from fetch_playing_11 import FetchActualPlaying11

    fetcher = FetchActualPlaying11()
    result = fetcher.fetch("KKR", "SRH")
    # Returns: {"team1": ["Ajinkya Rahane", ...], "team2": ["Abhishek Sharma", ...]}
    # Returns empty lists if playing XI not yet announced.
"""

import re
import logging
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ─── Constants ───────────────────────────────────────────────────────────────

_CRICBUZZ_HOME_API = "https://www.cricbuzz.com/api/home"
_CRICBUZZ_SQUADS_URL = "https://www.cricbuzz.com/cricket-match-squads/{match_id}/"
_IPL_SERIES_NAME_PATTERN = re.compile(r"indian\s+premier\s+league", re.IGNORECASE)

_REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
}
_REQUEST_TIMEOUT_SECONDS = 15

# IPL team abbreviation aliases — maps common variants to canonical short names.
# All keys MUST be lowercase.
_TEAM_ALIASES: dict[str, str] = {
    "csk": "CSK", "chennai super kings": "CSK", "chennai": "CSK",
    "mi": "MI", "mumbai indians": "MI", "mumbai": "MI",
    "kkr": "KKR", "kolkata knight riders": "KKR", "kolkata": "KKR",
    "dc": "DC", "delhi capitals": "DC", "delhi": "DC",
    "rcb": "RCB", "royal challengers bengaluru": "RCB",
    "royal challengers bangalore": "RCB", "bangalore": "RCB", "bengaluru": "RCB",
    "rr": "RR", "rajasthan royals": "RR", "rajasthan": "RR",
    "pbks": "PBKS", "punjab kings": "PBKS", "punjab": "PBKS",
    "srh": "SRH", "sunrisers hyderabad": "SRH", "hyderabad": "SRH",
    "lsg": "LSG", "lucknow super giants": "LSG", "lucknow": "LSG",
    "gt": "GT", "gujarat titans": "GT", "gujarat": "GT",
}


def _normalise_team_name(name: str) -> str:
    """Resolve any team name / abbreviation to its canonical short form (e.g. 'KKR')."""
    return _TEAM_ALIASES.get(name.strip().lower(), name.strip().upper())


class FetchActualPlaying11:
    """
    Fetches the actual Playing XI for a given IPL match from Cricbuzz.

    Workflow:
        1. Call Cricbuzz Home API to discover the match ID for a team1-vs-team2 fixture.
        2. Scrape the match squads page to extract Playing XI names.
        3. Return a dict with player name lists for each team.
    """

    def __init__(self, *, timeout: int = _REQUEST_TIMEOUT_SECONDS) -> None:
        self._timeout = timeout
        self._session = requests.Session()
        self._session.headers.update(_REQUEST_HEADERS)

    # ─── Public API ──────────────────────────────────────────────────────────

    def fetch(self, team1: str, team2: str) -> dict[str, list[str]]:
        """
        Fetch the Playing XI for both teams in an IPL match.

        Args:
            team1: Team name or abbreviation (e.g. "KKR", "Kolkata Knight Riders").
            team2: Team name or abbreviation (e.g. "SRH", "Sunrisers Hyderabad").

        Returns:
            A dict of the form:
                {"team1": ["Player A", ...], "team2": ["Player B", ...]}
            Lists are empty if the playing XI has not been announced yet,
            or if the match / squads page is unavailable.
        """
        empty_result: dict[str, list[str]] = {team1: [], team2: []}

        t1 = _normalise_team_name(team1)
        t2 = _normalise_team_name(team2)
        logger.info("Fetching Playing XI for %s vs %s", t1, t2)

        # Step 1 — resolve Cricbuzz match ID
        match_id = self._get_match_id(t1, t2)
        if match_id == -1:
            logger.warning("No IPL match found for %s vs %s on Cricbuzz Home API", t1, t2)
            return empty_result

        logger.info("Resolved Cricbuzz match ID: %d", match_id)

        # Step 2 — scrape the squads page for both playing XIs
        playing_xi = self._get_playing_xi(match_id, t1, t2)
        return playing_xi

    # ─── Private: Match ID resolution ────────────────────────────────────────

    def _get_match_id(self, team1: str, team2: str) -> int:
        """
        Query the Cricbuzz Home API and return the match ID for an IPL fixture
        involving *team1* and *team2* (canonical abbreviations).

        Returns -1 if no matching IPL fixture is found.
        """
        try:
            response = self._session.get(
                _CRICBUZZ_HOME_API,
                timeout=self._timeout,
            )
            response.raise_for_status()
            data = response.json()
        except (requests.RequestException, ValueError) as exc:
            logger.error("Failed to fetch Cricbuzz Home API: %s", exc)
            return -1

        matches = data.get("matches", [])
        pair = {team1.upper(), team2.upper()}

        for entry in matches:
            match_info = entry.get("match", {}).get("matchInfo", {})

            # Only consider IPL matches
            series_name = match_info.get("seriesName", "")
            if not _IPL_SERIES_NAME_PATTERN.search(series_name):
                continue

            t1_short = match_info.get("team1", {}).get("teamSName", "").upper()
            t2_short = match_info.get("team2", {}).get("teamSName", "").upper()

            if {t1_short, t2_short} == pair:
                return int(match_info["matchId"])

        return -1

    # ─── Private: Playing XI extraction ──────────────────────────────────────

    def _get_playing_xi(
        self,
        match_id: int,
        team1: str,
        team2: str,
    ) -> dict[str, list[str]]:
        """
        Scrape the Cricbuzz match-squads page and extract Playing XI fullNames
        for both teams.

        The page embeds squad data inside a Next.js RSC ``self.__next_f.push(...)``
        payload.  The playing XI block is identified by the literal key
        ``"playing XI"`` followed by a JSON array of player objects.  Each
        player object contains a ``"fullName"`` field with the complete name.

        Within the RSC blob there are two top-level team sections
        (``"team1"`` and ``"team2"``).  We identify which section corresponds
        to which franchise by inspecting the ``"teamSName"`` field (short
        abbreviation like ``"KKR"``), compared case-insensitively.

        Returns:
            {"team1": [...], "team2": [...]} where the keys correspond to the
            *caller's* team1 / team2, not Cricbuzz's internal ordering.
        """
        empty_result: dict[str, list[str]] = {team1: [], team2: []}

        url = _CRICBUZZ_SQUADS_URL.format(match_id=match_id)
        try:
            response = self._session.get(url, timeout=self._timeout)
            response.raise_for_status()
            html = response.text
        except requests.RequestException as exc:
            logger.error("Failed to fetch squads page (%s): %s", url, exc)
            return empty_result

        # Gather all RSC push chunks into a single string for regex scanning.
        rsc_blob = self._extract_rsc_blob(html)
        if not rsc_blob:
            logger.warning("No RSC payload found on squads page for match %d", match_id)
            return empty_result

        # Check if playing XI data exists at all
        if "playing XI" not in rsc_blob and "playing xi" not in rsc_blob.lower():
            logger.info("Playing XI not yet announced for match %d", match_id)
            return empty_result

        # Extract team sections and their playing XIs
        team_xi = self._parse_team_playing_xi(rsc_blob)
        if not team_xi:
            logger.info("Could not parse playing XI sections for match %d", match_id)
            return empty_result

        # Map Cricbuzz's team sections back to caller's team1 / team2
        result: dict[str, list[str]] = {team1: [], team2: []}
        for section_abbr, players in team_xi.items():
            if section_abbr.upper() == team1.upper():
                result[team1] = players
            elif section_abbr.upper() == team2.upper():
                result[team2] = players

        return result

    @staticmethod
    def _extract_rsc_blob(html: str) -> str:
        """
        Concatenate all ``self.__next_f.push([1, "..."])`` chunks into one string.

        The RSC payload is spread across multiple script tags; merging them gives
        us a single searchable text containing the full squad JSON fragments.
        """
        chunks = re.findall(r'self\.__next_f\.push\(\[1,\s*"(.*?)"\]\)', html, re.DOTALL)
        full_text = ""
        for chunk in chunks:
            try:
                decoded = chunk.encode("utf-8").decode("unicode_escape")
            except (UnicodeDecodeError, ValueError):
                decoded = chunk
            full_text += decoded
        return full_text

    @staticmethod
    def _parse_team_playing_xi(rsc_blob: str) -> dict[str, list[str]]:
        """
        Parse the RSC blob and return a mapping of team abbreviation → list of
        player full names from the ``"playing XI"`` section.

        Strategy — backward search:
            The RSC blob contains hundreds of ``teamSName`` entries from
            Cricbuzz's global sidebar (IND, AUS, ENG, …).  A forward regex
            ``teamSName.*?playing XI`` would incorrectly pair a sidebar entry
            with the first real playing XI block.

            Instead we:
            1. Find each ``"playing XI":[`` occurrence — there are exactly two
               for a match (one per team), each inside a ``"players":{…}`` block.
            2. Look **backwards** from each occurrence to find the nearest
               ``"teamSName":"XXX"`` — that is the team this block belongs to.
            3. Extract all ``fullName`` values from the array that follows.
        """
        result: dict[str, list[str]] = {}

        # Pattern to find the "playing XI":[ array declarations.
        # We anchor on the "players":{" prefix to avoid matching player-level
        # "playingXIChange" fields (which appear inside individual player objects).
        pxi_pattern = re.compile(
            r'"players"\s*:\s*\{\s*"playing\s*XI"\s*:\s*\[',
            re.IGNORECASE,
        )

        # Pattern to extract teamSName values (used for backward search).
        team_sname_pattern = re.compile(r'"teamSName"\s*:\s*"([^"]+)"')

        for pxi_match in pxi_pattern.finditer(rsc_blob):
            # Look backwards (up to 2000 chars) for the nearest teamSName
            search_start = max(0, pxi_match.start() - 2000)
            lookback_region = rsc_blob[search_start : pxi_match.start()]
            team_matches = list(team_sname_pattern.finditer(lookback_region))

            if not team_matches:
                logger.debug(
                    "playing XI block at pos %d: no teamSName found in lookback",
                    pxi_match.start(),
                )
                continue

            abbr = team_matches[-1].group(1).upper()  # nearest = last in lookback
            if abbr in result:
                continue  # already parsed (de-dup)

            # The '[' is the last char of the pxi_match
            arr_start = pxi_match.end() - 1
            names = FetchActualPlaying11._extract_full_names_from_array(rsc_blob, arr_start)
            if names:
                result[abbr] = names
                logger.debug("Parsed %d players for %s", len(names), abbr)

        return result

    @staticmethod
    def _extract_full_names_from_array(blob: str, arr_start: int) -> list[str]:
        """
        Starting from the ``[`` at *arr_start*, consume the JSON array of player
        objects and return all ``fullName`` values found before the matching ``]``.

        Uses simple bracket-depth counting rather than a full JSON parser because
        the blob is not valid standalone JSON (it's an RSC fragment with mixed
        content).
        """
        depth = 0
        end = arr_start
        for i in range(arr_start, min(arr_start + 100_000, len(blob))):
            ch = blob[i]
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break

        array_text = blob[arr_start:end]

        # Extract all fullName values.  They appear as either:
        #   \"fullName\":\"Ajinkya Rahane\"
        #   "fullName":"Ajinkya Rahane"
        name_pattern = re.compile(
            r'\\?"fullName\\?"\s*:\s*\\?"([^"\\]+)\\?"',
        )
        return [m.group(1).strip() for m in name_pattern.finditer(array_text)]


# ─── CLI entry point ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")

    # Run tests if --test flag is passed
    if "--test" in sys.argv:
        logging.getLogger().setLevel(logging.DEBUG)
        success = test_fetch()
        sys.exit(0 if success else 1)

    # ── Configure the two teams to fetch ─────────────────────────────────
    TEAM_1 = "LSG"
    TEAM_2 = "DC"
    # ─────────────────────────────────────────────────────────────────────

    print(f"\nFetching Playing XI: {TEAM_1} vs {TEAM_2}")
    print("=" * 50)

    fetcher = FetchActualPlaying11()
    result = fetcher.fetch(TEAM_1, TEAM_2)

    for team in (TEAM_1, TEAM_2):
        players = result.get(team, [])
        if players:
            print(f"\n{team} Playing XI ({len(players)} players):")
            for idx, name in enumerate(players, 1):
                print(f"  {idx:2d}. {name}")
        else:
            print(f"\n{team}: Playing XI not available yet")




# ─── Tests using sample data ─────────────────────────────────────────────────

def test_fetch():
    """Run all offline tests against sample data files."""
    import os
    import json

    SAMPLE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_data")
    MATCH_HTML = os.path.join(SAMPLE_DIR, "sample_cricbuzz_match_response.html")
    PLAYING_LINE_HTML = os.path.join(SAMPLE_DIR, "playing_11_line.html")

    EXPECTED_KKR = [
        "Ajinkya Rahane", "Cameron Green", "Angkrish Raghuvanshi",
        "Rinku Singh", "Ramandeep Singh", "Anukul Roy", "Sunil Narine",
        "Varun Chakaravarthy", "Vaibhav Arora", "Kartik Tyagi",
        "Blessing Muzarabani",
    ]
    EXPECTED_SRH = [
        "Abhishek Sharma", "Travis Head", "Ishan Kishan",
        "Heinrich Klaasen", "Aniket Verma", "Nitish Kumar Reddy",
        "Salil Arora", "Harsh Dubey", "Shivang Kumar",
        "Jaydev Unadkat", "David Payne",
    ]

    passed = 0
    failed = 0

    def assert_eq(label, actual, expected):
        nonlocal passed, failed
        if actual == expected:
            print(f"  [PASS] {label}")
            passed += 1
        else:
            print(f"  [FAIL] {label}")
            print(f"       Expected: {expected}")
            print(f"       Actual:   {actual}")
            failed += 1

    def separator(title):
        print(f"\n{'='*60}\n  {title}\n{'='*60}")

    # ── Test 1: RSC blob extraction from full match HTML ─────────────────

    separator("Test 1: _extract_rsc_blob (full match HTML)")
    with open(MATCH_HTML, "r", encoding="utf-8") as f:
        full_html = f.read()

    blob_full = FetchActualPlaying11._extract_rsc_blob(full_html)
    assert_eq("blob is non-empty", len(blob_full) > 0, True)
    assert_eq("blob contains 'playing XI'", "playing XI" in blob_full, True)
    assert_eq("blob contains 'teamSName'", "teamSName" in blob_full, True)

    # ── Test 2: RSC blob extraction from isolated playing_11_line ────────

    separator("Test 2: _extract_rsc_blob (playing_11_line.html)")
    with open(PLAYING_LINE_HTML, "r", encoding="utf-8") as f:
        line_html = f.read()

    blob_line = FetchActualPlaying11._extract_rsc_blob(line_html)
    assert_eq("line blob is non-empty", len(blob_line) > 0, True)
    assert_eq("line blob contains 'playing XI'", "playing XI" in blob_line, True)

    # ── Test 3: _parse_team_playing_xi from full HTML blob ───────────────

    separator("Test 3: _parse_team_playing_xi (full match HTML blob)")
    result_full = FetchActualPlaying11._parse_team_playing_xi(blob_full)

    assert_eq("found KKR key", "KKR" in result_full, True)
    assert_eq("found SRH key", "SRH" in result_full, True)
    assert_eq("KKR has 11 players", len(result_full.get("KKR", [])), 11)
    assert_eq("SRH has 11 players", len(result_full.get("SRH", [])), 11)
    assert_eq("KKR player list matches", result_full.get("KKR", []), EXPECTED_KKR)
    assert_eq("SRH player list matches", result_full.get("SRH", []), EXPECTED_SRH)

    if result_full.get("KKR"):
        print(f"\n  KKR Playing XI:")
        for i, name in enumerate(result_full["KKR"], 1):
            print(f"    {i:2d}. {name}")
    if result_full.get("SRH"):
        print(f"\n  SRH Playing XI:")
        for i, name in enumerate(result_full["SRH"], 1):
            print(f"    {i:2d}. {name}")

    # ── Test 4: _parse_team_playing_xi from isolated line blob ───────────

    separator("Test 4: _parse_team_playing_xi (playing_11_line.html blob)")
    result_line = FetchActualPlaying11._parse_team_playing_xi(blob_line)

    assert_eq("line: found KKR key", "KKR" in result_line, True)
    assert_eq("line: found SRH key", "SRH" in result_line, True)
    assert_eq("line: KKR has 11 players", len(result_line.get("KKR", [])), 11)
    assert_eq("line: SRH has 11 players", len(result_line.get("SRH", [])), 11)
    assert_eq("line: KKR matches expected", result_line.get("KKR", []), EXPECTED_KKR)
    assert_eq("line: SRH matches expected", result_line.get("SRH", []), EXPECTED_SRH)

    # ── Test 5: _extract_full_names_from_array edge cases ────────────────

    separator("Test 5: _extract_full_names_from_array edge cases")

    assert_eq(
        "empty array returns []",
        FetchActualPlaying11._extract_full_names_from_array("[]", 0),
        [],
    )

    mini_blob = '[{"fullName":"Alice"},{"fullName":"Bob"}]'
    assert_eq(
        "simple array extracts names",
        FetchActualPlaying11._extract_full_names_from_array(mini_blob, 0),
        ["Alice", "Bob"],
    )

    # ── Test 6: _get_match_id with sample JSON (offline) ─────────────────

    separator("Test 6: _get_match_id (offline with sample JSON)")
    sample_json = os.path.join(SAMPLE_DIR, "sample_cricbuzz_api_home_response.json")
    if os.path.exists(sample_json) and os.path.getsize(sample_json) > 0:
        with open(sample_json, "r", encoding="utf-8") as f:
            home_data = json.load(f)

        # Simulate the match ID lookup manually
        match_id_found = -1
        pair = {"SRH", "KKR"}
        for entry in home_data.get("matches", []):
            match_info = entry.get("match", {}).get("matchInfo", {})
            series_name = match_info.get("seriesName", "")
            if "Indian Premier League" not in series_name:
                continue
            t1 = match_info.get("team1", {}).get("teamSName", "").upper()
            t2 = match_info.get("team2", {}).get("teamSName", "").upper()
            if {t1, t2} == pair:
                match_id_found = match_info["matchId"]

        assert_eq("SRH vs KKR match ID is 149673", match_id_found, 149673)

        # CSK vs PBKS
        pair2 = {"CSK", "PBKS"}
        match_id_2 = -1
        for entry in home_data.get("matches", []):
            match_info = entry.get("match", {}).get("matchInfo", {})
            series_name = match_info.get("seriesName", "")
            if "Indian Premier League" not in series_name:
                continue
            t1 = match_info.get("team1", {}).get("teamSName", "").upper()
            t2 = match_info.get("team2", {}).get("teamSName", "").upper()
            if {t1, t2} == pair2:
                match_id_2 = match_info["matchId"]

        assert_eq("CSK vs PBKS match ID is 149684", match_id_2, 149684)
    else:
        print("  [SKIP] sample JSON file missing or empty")

    # ── Summary ──────────────────────────────────────────────────────────

    separator("SUMMARY")
    total = passed + failed
    print(f"  {passed}/{total} passed, {failed}/{total} failed")
    if failed > 0:
        print("  ** Some tests failed! **")
        return False
    else:
        print("  All tests passed!")
        return True