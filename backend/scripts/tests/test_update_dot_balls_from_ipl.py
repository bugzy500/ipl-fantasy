"""
Unit tests for update_dot_balls_from_ipl() in ipl-scraper.py.

Run:
    cd backend/scripts
    python3 test_update_dot_balls_from_ipl.py

These tests exercise only update_dot_balls_from_ipl + _clean_ipl_player_name.
No MongoDB, no network, no WhatsApp. Everything is faked.

Why this file loads ipl-scraper.py via importlib:
    The scraper's filename has a hyphen, so `import ipl-scraper` is illegal.
    We also stub `infinity_max_brain` before import so we don't pull in its
    transitive deps just to test 150 lines of code.
"""

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock

# ── Stub out transitive imports the scraper does at module load time ─────────
# infinity_max_brain is imported at the top of ipl-scraper.py; we don't need it.
fake_imb = types.ModuleType("infinity_max_brain")
fake_imb.auto_build_and_submit = lambda *a, **kw: None
fake_imb.build_team_summary_message = lambda *a, **kw: None
fake_imb.INFINITY_MAX_USER_ID = "stub"
sys.modules.setdefault("infinity_max_brain", fake_imb)

# ── Load ipl-scraper.py as module `scraper` ──────────────────────────────────
SCRAPER_PATH = Path(__file__).parent / "ipl-scraper.py"
spec = importlib.util.spec_from_file_location("scraper", SCRAPER_PATH)
scraper = importlib.util.module_from_spec(spec)
sys.modules["scraper"] = scraper
spec.loader.exec_module(scraper)

# Pull the symbols we need
update_dot_balls_from_ipl = scraper.update_dot_balls_from_ipl
_clean_ipl_player_name = scraper._clean_ipl_player_name

# Bring in dataclasses/exception from the real feed module — we'll use them
# to build mock scoreboards so we test against the exact shapes the real
# client returns.
from ipl_official_feed import (
    IPLFeedError,
    MatchLink,
    MatchScoreboard,
    InningsScoreboard,
    BowlerStats,
    BatsmanStats,
)


# ── Fakes ────────────────────────────────────────────────────────────────────


class FakeCollection:
    """Minimal fake for db.playerperformances / db.matches."""

    def __init__(self):
        self.docs = []
        self.update_calls = []
        # Queue of predetermined find_one responses. If empty, find_one
        # scans self.docs for a matching dict — crude but enough for guards.
        self._find_one_queue = None

    def queue_find_one(self, *responses):
        self._find_one_queue = list(responses)

    def find_one(self, query):
        if self._find_one_queue is not None and self._find_one_queue:
            return self._find_one_queue.pop(0)
        # naive match: no query ops, just direct equality
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items() if not isinstance(v, dict)):
                return doc
        return None

    def update_one(self, filter_, update, **kwargs):
        self.update_calls.append((filter_, update))
        # Simulate MongoDB: modified_count = 1 if we'd match something.
        # Individual tests override via self.modified_count_for_next.
        mod = getattr(self, "_next_modified_count", 1)
        if hasattr(self, "_next_modified_count"):
            del self._next_modified_count
        result = MagicMock()
        result.modified_count = mod
        return result

    def set_next_modified_count(self, n):
        self._next_modified_count = n


class FakeDB:
    def __init__(self):
        self.playerperformances = FakeCollection()
        self.matches = FakeCollection()


class FakeIPLClient:
    """Stand-in for IPLOfficialFeed with programmable responses."""

    def __init__(self):
        self.match_by_teams = None           # MatchLink | None
        self.match_by_teams_after_refresh = None
        self.scoreboard = None               # MatchScoreboard
        self.fetch_error = None              # exception to raise
        self.find_calls = 0
        self.refresh_calls = 0
        self.fetch_calls = 0

    def find_match_by_teams(self, t1, t2):
        self.find_calls += 1
        # First call: use match_by_teams; after refresh: use alternate
        if self.find_calls == 1:
            return self.match_by_teams
        return self.match_by_teams_after_refresh

    def fetch_match_links(self, force_refresh=False):
        self.refresh_calls += 1
        return []

    def fetch_scoreboard(self, smid):
        self.fetch_calls += 1
        if self.fetch_error:
            raise self.fetch_error
        return self.scoreboard


# ── Helpers to build mock domain objects ─────────────────────────────────────


def make_link(smid=9999, num=22, t1="csk", t2="kkr"):
    return MatchLink(
        match_id=smid, match_number=num, team1=t1, team2=t2,
        highlights_url="", report_url="",
    )


def make_bowler(name, dots, overs=4.0, wickets=1):
    return BowlerStats(
        player_id="",
        name=name,
        overs=overs,
        maidens=0,
        runs_conceded=30,
        wickets=wickets,
        dot_balls=dots,
        economy=7.5,
        wides=0,
        no_balls=0,
        legal_balls=int(overs * 6),
    )


def make_innings(inno, bowlers):
    return InningsScoreboard(
        innings_no=inno, match_id=9999, team_id=1,
        batting=[], bowling=bowlers,
    )


def make_scoreboard(innings_list):
    return MatchScoreboard(match_id=9999, innings=innings_list)


def make_match(
    _id="m1",
    status="completed",
    team1="CSK",
    team2="KKR",
    ipl_match_id=None,
):
    m = {"_id": _id, "status": status, "team1": team1, "team2": team2}
    if ipl_match_id is not None:
        m["iplMatchId"] = ipl_match_id
    return m


def install_fake_client(fake):
    scraper._ipl_client = fake


# ── Tests ────────────────────────────────────────────────────────────────────


class TestCleanPlayerName(unittest.TestCase):
    def test_strips_parentheses(self):
        self.assertEqual(_clean_ipl_player_name("Ajinkya Rahane (c)"), "ajinkya rahane")
        self.assertEqual(_clean_ipl_player_name("Finn Allen  (IP)"), "finn allen")
        self.assertEqual(_clean_ipl_player_name("Varun Chakaravarthy (RP)"), "varun chakaravarthy")

    def test_lowercases(self):
        self.assertEqual(_clean_ipl_player_name("Jasprit BUMRAH"), "jasprit bumrah")

    def test_empty_and_none(self):
        self.assertEqual(_clean_ipl_player_name(""), "")
        self.assertEqual(_clean_ipl_player_name(None), "")

    def test_no_markers_untouched(self):
        self.assertEqual(_clean_ipl_player_name("Ravindra Jadeja"), "ravindra jadeja")


class TestGuards(unittest.TestCase):
    """All short-circuits should return 0 and NOT call the IPL client."""

    def setUp(self):
        self.db = FakeDB()
        self.client = FakeIPLClient()
        install_fake_client(self.client)

    def _assert_client_untouched(self):
        self.assertEqual(self.client.find_calls, 0)
        self.assertEqual(self.client.fetch_calls, 0)

    def test_skip_if_ipl_match_id_set(self):
        match = make_match(ipl_match_id=1234)
        result = update_dot_balls_from_ipl(self.db, match, {})
        self.assertEqual(result, 0)
        self._assert_client_untouched()

    def test_skip_if_not_completed(self):
        match = make_match(status="live")
        result = update_dot_balls_from_ipl(self.db, match, {})
        self.assertEqual(result, 0)
        self._assert_client_untouched()

    def test_skip_if_missing_team_abbrev(self):
        match = make_match(team1="", team2="KKR")
        result = update_dot_balls_from_ipl(self.db, match, {})
        self.assertEqual(result, 0)
        self._assert_client_untouched()

    def test_skip_if_already_has_dots(self):
        match = make_match()
        # Make the "already has dots > 0" find_one return a hit.
        self.db.playerperformances.queue_find_one({"dotBalls": 5})
        result = update_dot_balls_from_ipl(self.db, match, {})
        self.assertEqual(result, 0)
        self._assert_client_untouched()


class TestFeedFailures(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.client = FakeIPLClient()
        install_fake_client(self.client)
        # dots-not-present guard passes
        self.db.playerperformances.queue_find_one(None)

    def test_matchlinks_miss_both_tries(self):
        self.client.match_by_teams = None
        self.client.match_by_teams_after_refresh = None
        match = make_match()
        result = update_dot_balls_from_ipl(self.db, match, {})
        self.assertEqual(result, 0)
        # Should have tried twice and forced a refresh in between
        self.assertEqual(self.client.find_calls, 2)
        self.assertEqual(self.client.refresh_calls, 1)
        self.assertEqual(self.client.fetch_calls, 0)
        # No iplMatchId should be stamped
        self.assertEqual(len(self.db.matches.update_calls), 0)

    def test_fetch_scoreboard_raises_feed_error(self):
        self.client.match_by_teams = make_link()
        self.client.fetch_error = IPLFeedError("S3 down")
        match = make_match()
        result = update_dot_balls_from_ipl(self.db, match, {})
        self.assertEqual(result, 0)
        self.assertEqual(self.client.fetch_calls, 1)
        self.assertEqual(len(self.db.matches.update_calls), 0)

    def test_fetch_scoreboard_raises_unexpected(self):
        self.client.match_by_teams = make_link()
        self.client.fetch_error = RuntimeError("boom")
        match = make_match()
        result = update_dot_balls_from_ipl(self.db, match, {})
        self.assertEqual(result, 0)

    def test_single_innings_terminates(self):
        self.client.match_by_teams = make_link()
        self.client.scoreboard = make_scoreboard([
            make_innings(1, [make_bowler("Jasprit Bumrah", 10)]),
        ])
        match = make_match()
        result = update_dot_balls_from_ipl(self.db, match, {"jasprit bumrah": {"_id": "p1"}})
        self.assertEqual(result, 0)
        self.assertEqual(len(self.db.matches.update_calls), 0)


class TestHappyPath(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        self.client = FakeIPLClient()
        install_fake_client(self.client)
        self.db.playerperformances.queue_find_one(None)  # no existing dots

        self.client.match_by_teams = make_link(smid=2462)
        self.client.scoreboard = make_scoreboard([
            make_innings(1, [
                make_bowler("Jasprit Bumrah", 12),
                make_bowler("Hardik Pandya (c)", 4),
            ]),
            make_innings(2, [
                make_bowler("Varun Chakaravarthy (RP)", 15),
                make_bowler("Sunil Narine", 9),
            ]),
        ])

    def test_writes_dot_balls_and_stamps_ipl_match_id(self):
        players_by_name = {
            "jasprit bumrah": {"_id": "p1"},
            "hardik pandya":  {"_id": "p2"},
            "varun chakaravarthy": {"_id": "p3"},
            "sunil narine": {"_id": "p4"},
        }
        match = make_match(_id="m1")
        result = update_dot_balls_from_ipl(self.db, match, players_by_name)

        self.assertEqual(result, 4)
        # Four performance updates + one match update (iplMatchId)
        self.assertEqual(len(self.db.playerperformances.update_calls), 4)
        self.assertEqual(len(self.db.matches.update_calls), 1)

        match_filter, match_update = self.db.matches.update_calls[0]
        self.assertEqual(match_filter, {"_id": "m1"})
        self.assertEqual(match_update, {"$set": {"iplMatchId": 2462}})

        # Check the dot ball values made it through to the $set payload
        by_pid = {
            call[0]["playerId"]: call[1]["$set"]["dotBalls"]
            for call in self.db.playerperformances.update_calls
        }
        self.assertEqual(by_pid["p1"], 12)
        self.assertEqual(by_pid["p2"], 4)
        self.assertEqual(by_pid["p3"], 15)
        self.assertEqual(by_pid["p4"], 9)

        # Every PP update filter must include oversBowled > 0 to avoid
        # writing dots onto a pure-fielder row.
        for filter_, _ in self.db.playerperformances.update_calls:
            self.assertEqual(filter_["oversBowled"], {"$gt": 0})

    def test_matchlinks_cache_stale_then_refresh_succeeds(self):
        # First find_match_by_teams returns None; after refresh we succeed.
        self.client.match_by_teams = None
        self.client.match_by_teams_after_refresh = make_link(smid=2462)
        players_by_name = {
            "jasprit bumrah": {"_id": "p1"},
            "hardik pandya":  {"_id": "p2"},
            "varun chakaravarthy": {"_id": "p3"},
            "sunil narine": {"_id": "p4"},
        }
        result = update_dot_balls_from_ipl(self.db, make_match(), players_by_name)
        self.assertEqual(result, 4)
        self.assertEqual(self.client.find_calls, 2)
        self.assertEqual(self.client.refresh_calls, 1)

    def test_unmatched_names_are_logged_not_written(self):
        # Only two of the four bowlers are in the name map.
        players_by_name = {
            "jasprit bumrah": {"_id": "p1"},
            "sunil narine": {"_id": "p4"},
        }
        result = update_dot_balls_from_ipl(self.db, make_match(), players_by_name)
        self.assertEqual(result, 2)
        self.assertEqual(len(self.db.playerperformances.update_calls), 2)
        # iplMatchId still stamped — we did some work
        self.assertEqual(len(self.db.matches.update_calls), 1)

    def test_zero_modified_count_means_no_ipl_match_id_stamp(self):
        # All updates return modified_count=0 — e.g. oversBowled filter missed
        # every performance row (all fielders). Should NOT stamp iplMatchId
        # so next run can retry.
        players_by_name = {
            "jasprit bumrah": {"_id": "p1"},
            "hardik pandya":  {"_id": "p2"},
            "varun chakaravarthy": {"_id": "p3"},
            "sunil narine": {"_id": "p4"},
        }
        # Force every update_one to return modified_count=0
        real_update_one = self.db.playerperformances.update_one

        def zero_update(filter_, update, **kw):
            self.db.playerperformances.update_calls.append((filter_, update))
            r = MagicMock()
            r.modified_count = 0
            return r
        self.db.playerperformances.update_one = zero_update

        result = update_dot_balls_from_ipl(self.db, make_match(), players_by_name)
        self.assertEqual(result, 0)
        # Four PP updates attempted, zero match-level updates stamped
        self.assertEqual(len(self.db.playerperformances.update_calls), 4)
        self.assertEqual(len(self.db.matches.update_calls), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
