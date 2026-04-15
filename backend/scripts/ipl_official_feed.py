"""
IPL Official Feed Client
========================

Client for IPL's official S3 stats feeds (the same feeds that power iplt20.com).
Provides clean, structured access to match listings and per-innings scoreboards —
including **dot balls**, which neither Cricbuzz nor ESPN expose reliably.

This module is intentionally decoupled from ipl-scraper.py. It exposes a single
class (`IPLOfficialFeed`) and typed dataclasses so callers can integrate it with
one or two lines.

Typical usage:

    from ipl_official_feed import IPLOfficialFeed

    client = IPLOfficialFeed(season="2026")

    # Get all completed match IDs for the season
    links = client.fetch_match_links()
    print(f"{len(links)} completed matches")

    # Fetch scoreboard for a specific match (both innings)
    match = client.fetch_scoreboard(match_id=2462)
    for inn in match.innings:
        print(f"Innings {inn.innings_no}: {len(inn.batting)} batters, {len(inn.bowling)} bowlers")
        for b in inn.bowling:
            print(f"  {b.name}: {b.overs} overs, {b.wickets} wkts, {b.dot_balls} dots")

    # Fetch a single innings
    innings = client.fetch_scoreboard(match_id=2462, innings=2)

    # Find a match by number or by team pair
    m22 = client.find_match_by_number(22)
    csk_vs_kkr = client.find_match_by_teams("csk", "kkr")

Upstream feed URLs (undocumented, reverse-engineered from iplt20.com):

  Match listing:   /ipl/feeds/stats/{season}-matchlinks.js
  Per-innings:     /ipl/feeds/{matchId}-Innings{1|2}.js

Both are JSONP (wrapped in `onMatchLinks(...)` / `onScoring(...)` callbacks).

WARNING: These feeds are undocumented and could change or disappear without
notice. Always wrap calls in try/except in production code.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Union

import requests


BASE_URL = "https://ipl-stats-sports-mechanic.s3.ap-south-1.amazonaws.com/ipl/feeds"
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
DEFAULT_TIMEOUT = 15


# ── Data classes ────────────────────────────────────────────────────────────


@dataclass
class MatchLink:
    """Single entry from the season matchlinks feed."""
    match_id: int                 # smId — the ID used in the innings feed URL
    match_number: int             # e.g. 22 for "m22"; 0 if unparseable
    team1: str                    # abbreviation (lowercased, e.g. "csk"); "" if unparseable
    team2: str                    # abbreviation (lowercased, e.g. "kkr"); "" if unparseable
    highlights_url: str
    report_url: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BatsmanStats:
    player_id: str
    name: str
    runs: int
    balls: int
    dot_balls: int
    fours: int
    sixes: int
    strike_rate: float
    is_out: bool
    out_desc: str
    dismissing_bowler: str        # "" if not out

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BowlerStats:
    player_id: str
    name: str
    overs: float
    maidens: int
    runs_conceded: int
    wickets: int
    dot_balls: int
    economy: float
    wides: int
    no_balls: int
    legal_balls: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class InningsScoreboard:
    innings_no: int               # 1 or 2
    match_id: int
    team_id: int                  # batting team ID (iplt20.com internal)
    batting: List[BatsmanStats] = field(default_factory=list)
    bowling: List[BowlerStats] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "innings_no": self.innings_no,
            "match_id": self.match_id,
            "team_id": self.team_id,
            "batting": [b.to_dict() for b in self.batting],
            "bowling": [b.to_dict() for b in self.bowling],
        }


@dataclass
class MatchScoreboard:
    """Full match: one or both innings."""
    match_id: int
    innings: List[InningsScoreboard] = field(default_factory=list)

    def get_innings(self, innings_no: int) -> Optional[InningsScoreboard]:
        for inn in self.innings:
            if inn.innings_no == innings_no:
                return inn
        return None

    def to_dict(self) -> dict:
        return {
            "match_id": self.match_id,
            "innings": [inn.to_dict() for inn in self.innings],
        }


# ── Exceptions ──────────────────────────────────────────────────────────────


class IPLFeedError(Exception):
    """Raised on any feed fetch or parse failure."""


# ── Main client ─────────────────────────────────────────────────────────────


class IPLOfficialFeed:
    """
    Client for IPL's official S3 stat feeds.

    Construct once per season and reuse — the underlying requests.Session
    is kept alive so multiple calls share the connection pool.
    """

    # report URL pattern: ".../tata-ipl-{season}-match-{num}-{team1}-vs-{team2}-match-report"
    _REPORT_RE = re.compile(
        r"tata-ipl-\d{4}-match-(\d+)-([a-z]+)-vs-([a-z]+)-match-report",
        re.IGNORECASE,
    )
    # highlights URL pattern: ".../ipl-{season}-m{num}-{team1}-vs-{team2}---match-highlights"
    _HIGHLIGHTS_RE = re.compile(
        r"ipl-\d{4}-m(\d+)-([a-z]+)-vs-([a-z]+)---match-highlights",
        re.IGNORECASE,
    )

    def __init__(
        self,
        season: str = "2026",
        user_agent: str = DEFAULT_UA,
        timeout: int = DEFAULT_TIMEOUT,
    ):
        self.season = season
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": user_agent})
        # Simple in-process cache so repeat calls don't re-hit S3.
        self._matchlinks_cache: Optional[List[MatchLink]] = None

    # ── Public API ──────────────────────────────────────────────────────────

    def fetch_match_links(self, force_refresh: bool = False) -> List[MatchLink]:
        """
        Fetch the season matchlinks feed and return all completed matches.

        Note: this feed only contains matches that have published highlights
        and reports, so LIVE and UPCOMING matches will NOT appear here. For
        live matches you'll need to know the match ID from another source.

        Results are cached in memory; pass force_refresh=True to re-fetch.
        """
        if self._matchlinks_cache is not None and not force_refresh:
            return self._matchlinks_cache

        url = f"{BASE_URL}/stats/{self.season}-matchlinks.js"
        payload = self._fetch_jsonp(url, expected_callback="onMatchLinks")

        if not isinstance(payload, list):
            raise IPLFeedError(f"matchlinks payload is not a list: got {type(payload).__name__}")

        results: List[MatchLink] = []
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            match_id = entry.get("smId")
            if not isinstance(match_id, int):
                continue
            report_url = entry.get("report", "") or ""
            highlights_url = entry.get("highlights", "") or ""
            match_num, t1, t2 = self._parse_match_metadata(report_url, highlights_url)
            results.append(MatchLink(
                match_id=match_id,
                match_number=match_num,
                team1=t1,
                team2=t2,
                highlights_url=highlights_url,
                report_url=report_url,
            ))

        self._matchlinks_cache = results
        return results

    def get_latest_match_id(self) -> Optional[int]:
        """Return the match ID of the most recently completed match (highest smId)."""
        links = self.fetch_match_links()
        if not links:
            return None
        return max(link.match_id for link in links)

    def find_match_by_number(self, match_number: int) -> Optional[MatchLink]:
        """Find a match by its season match number (e.g. 22 for m22)."""
        for link in self.fetch_match_links():
            if link.match_number == match_number:
                return link
        return None

    def find_match_by_teams(self, team1: str, team2: str) -> Optional[MatchLink]:
        """
        Find a match by team abbreviation pair (case-insensitive, order-insensitive).
        If multiple matches between the same pair exist, returns the most recent.
        """
        t1, t2 = team1.lower(), team2.lower()
        candidates = [
            link for link in self.fetch_match_links()
            if {link.team1, link.team2} == {t1, t2}
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda l: l.match_id)

    def fetch_scoreboard(
        self,
        match_id: int,
        innings: Optional[int] = None,
    ) -> MatchScoreboard:
        """
        Fetch the scoreboard for a match.

        Args:
            match_id: IPL match ID (smId from matchlinks, or known externally).
            innings:  1 or 2 for a specific innings. If None, fetches BOTH innings.
                      Innings that don't exist yet (e.g. match still in progress)
                      are silently skipped — check result.innings for what was returned.

        Returns:
            MatchScoreboard with one or two InningsScoreboard entries.

        Raises:
            IPLFeedError if the HTTP request fails or payload is malformed AND
            no innings could be parsed at all. Partial results (e.g. innings 1
            parsed, innings 2 404) are returned without raising.
        """
        if innings is not None and innings not in (1, 2):
            raise ValueError(f"innings must be 1, 2, or None; got {innings}")

        targets = [innings] if innings else [1, 2]
        parsed: List[InningsScoreboard] = []
        last_error: Optional[Exception] = None

        for inn_no in targets:
            try:
                inn = self._fetch_single_innings(match_id, inn_no)
                if inn is not None:
                    parsed.append(inn)
            except IPLFeedError as e:
                last_error = e
                # If the user asked for both innings and one is missing, keep going.
                if innings is not None:
                    raise

        if not parsed and last_error is not None:
            raise last_error

        return MatchScoreboard(match_id=match_id, innings=parsed)

    # ── Internal helpers ────────────────────────────────────────────────────

    def _fetch_single_innings(self, match_id: int, innings_no: int) -> Optional[InningsScoreboard]:
        """Fetch one innings file and parse it. Returns None if the feed is empty."""
        url = f"{BASE_URL}/{match_id}-Innings{innings_no}.js"
        payload = self._fetch_jsonp(url, expected_callback="onScoring")

        if not isinstance(payload, dict):
            return None

        # Feed shape: {"Innings1": {...}} or {"Innings2": {...}}
        key = f"Innings{innings_no}"
        inn_data = payload.get(key)
        if not isinstance(inn_data, dict):
            return None

        return self._parse_innings_dict(inn_data, innings_no)

    def _parse_innings_dict(self, inn: dict, innings_no: int) -> InningsScoreboard:
        batting_raw = inn.get("BattingCard", []) or []
        bowling_raw = inn.get("BowlingCard", []) or []

        batting = [self._parse_batsman(p) for p in batting_raw if isinstance(p, dict)]
        bowling = [self._parse_bowler(p) for p in bowling_raw if isinstance(p, dict)]

        match_id = 0
        team_id = 0
        if batting_raw and isinstance(batting_raw[0], dict):
            match_id = _to_int(batting_raw[0].get("MatchID"))
            team_id = _to_int(batting_raw[0].get("TeamID"))

        return InningsScoreboard(
            innings_no=innings_no,
            match_id=match_id,
            team_id=team_id,
            batting=batting,
            bowling=bowling,
        )

    @staticmethod
    def _parse_batsman(p: dict) -> BatsmanStats:
        out_desc = (p.get("OutDesc") or "").strip()
        is_out = bool(out_desc) and out_desc.lower() not in ("not out", "notout")
        return BatsmanStats(
            player_id=str(p.get("PlayerID", "")),
            name=(p.get("PlayerName") or "").strip(),
            runs=_to_int(p.get("Runs")),
            balls=_to_int(p.get("Balls")),
            dot_balls=_to_int(p.get("DotBalls")),
            fours=_to_int(p.get("Fours")),
            sixes=_to_int(p.get("Sixes")),
            strike_rate=_to_float(p.get("StrikeRate")),
            is_out=is_out,
            out_desc=out_desc,
            dismissing_bowler=(p.get("BowlerName") or "").strip(),
        )

    @staticmethod
    def _parse_bowler(p: dict) -> BowlerStats:
        return BowlerStats(
            player_id=str(p.get("PlayerID", "")),
            name=(p.get("PlayerName") or "").strip(),
            overs=_to_float(p.get("Overs")),
            maidens=_to_int(p.get("Maidens")),
            runs_conceded=_to_int(p.get("Runs")),
            wickets=_to_int(p.get("Wickets")),
            dot_balls=_to_int(p.get("DotBalls")),
            economy=_to_float(p.get("Economy")),
            wides=_to_int(p.get("Wides")),
            no_balls=_to_int(p.get("NoBalls")),
            legal_balls=_to_int(p.get("TotalLegalBallsBowled")),
        )

    def _parse_match_metadata(self, report_url: str, highlights_url: str) -> tuple:
        """Extract (match_number, team1, team2) from either URL; returns (0, '', '') on failure."""
        for url, pattern in ((report_url, self._REPORT_RE), (highlights_url, self._HIGHLIGHTS_RE)):
            if not url:
                continue
            m = pattern.search(url)
            if m:
                return (int(m.group(1)), m.group(2).lower(), m.group(3).lower())
        return (0, "", "")

    def _fetch_jsonp(self, url: str, expected_callback: Optional[str] = None) -> Union[dict, list]:
        """
        Fetch a JSONP URL and return the parsed payload (dict or list).

        Strips the callback wrapper by locating the outermost parentheses —
        more robust than regex since JSON content can contain parens.
        """
        try:
            r = self._session.get(url, timeout=self.timeout)
        except requests.RequestException as e:
            raise IPLFeedError(f"HTTP error fetching {url}: {e}") from e

        if r.status_code != 200:
            raise IPLFeedError(f"HTTP {r.status_code} for {url}")

        text = r.text or ""
        if not text.strip():
            raise IPLFeedError(f"Empty response from {url}")

        # Optional sanity check: does the response start with the expected callback?
        if expected_callback and not text.lstrip().startswith(expected_callback):
            # Not fatal — just a warning signal. The paren-strip below still works.
            pass

        start = text.find("(")
        end = text.rfind(")")
        if start == -1 or end == -1 or end <= start:
            raise IPLFeedError(f"Could not locate JSONP wrapper in {url}")

        try:
            return json.loads(text[start + 1:end])
        except json.JSONDecodeError as e:
            raise IPLFeedError(f"Invalid JSON in {url}: {e}") from e

    def close(self):
        """Close the underlying requests session."""
        self._session.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ── Module-level coercion helpers ───────────────────────────────────────────


def _to_int(v, default: int = 0) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _to_float(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ── CLI smoke test ──────────────────────────────────────────────────────────


if __name__ == "__main__":
    """
    Quick smoke test. Run:
        python ipl_official_feed.py
    """
    ipl_id = IPLOfficialFeed(season="2026").get_latest_match_id()
    ipl_id_match_22 = IPLOfficialFeed(season="2026").find_match_by_number(22)
    print(f"Latest match ID: {ipl_id}")
    print(f"Match ID for match 22: {ipl_id_match_22.match_id if ipl_id_match_22 else 'not found'}")
    with IPLOfficialFeed(season="2026") as client:
        print(f"Fetching matchlinks for {client.season}...")
        links = client.fetch_match_links()
        print(f"  Found {len(links)} completed matches")
        if links:
            latest = max(links, key=lambda l: l.match_id)
            print(f"  Latest: m{latest.match_number} "
                  f"{latest.team1.upper()} vs {latest.team2.upper()} "
                  f"(match_id={latest.match_id})")

            print(f"\nFetching full scoreboard for match {latest.match_id}...")
            match = client.fetch_scoreboard(latest.match_id)
            for inn in match.innings:
                print(f"\n  Innings {inn.innings_no} (team {inn.team_id}): "
                      f"{len(inn.batting)} batters, {len(inn.bowling)} bowlers")
                print(f"    Top bowler by dots:")
                if inn.bowling:
                    top = max(inn.bowling, key=lambda b: b.dot_balls)
                    print(f"      {top.name}: {top.overs} ov, {top.wickets} wkts, "
                          f"{top.dot_balls} dots, econ {top.economy}")
