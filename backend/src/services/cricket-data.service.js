/**
 * CricketData.org API Integration
 * Free tier: 100 hits/day — poll smartly.
 *
 * Env: CRICKET_DATA_API_KEY
 * Docs: https://cricketdata.org
 */
const Match = require('../models/Match.model');

const BASE_URL = 'https://api.cricapi.com/v1';

function apiKey() {
  return process.env.CRICKET_DATA_API_KEY;
}

async function apiFetch(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('apikey', apiKey());
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`CricketData API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`CricketData API error: ${data.info || 'Unknown'}`);
  return data;
}

/**
 * Get current live matches (IPL filter)
 */
async function getLiveMatches() {
  const data = await apiFetch('currentMatches', { offset: 0 });
  // Filter to IPL T20 matches
  return (data.data || []).filter(
    (m) => m.series_id && m.matchType === 't20' && (m.name || '').toLowerCase().includes('ipl')
  );
}

/**
 * Get scorecard for a specific match
 * Returns batting + bowling arrays per innings
 */
async function getScorecard(cricApiMatchId) {
  const data = await apiFetch('match_scorecard', { id: cricApiMatchId });
  return data.data;
}

/**
 * Get match info (playing XI, toss, status)
 */
async function getMatchInfo(cricApiMatchId) {
  const data = await apiFetch('match_info', { id: cricApiMatchId });
  return data.data;
}

/**
 * Map CricketData scorecard to our PlayerPerformance format.
 * Takes scorecard data and our Player docs, returns performances array.
 */
function mapScorecardToPerformances(scorecard, playersByName) {
  const performances = new Map(); // playerId -> perf object

  const initPerf = (playerId) => ({
    playerId,
    runs: 0, ballsFaced: 0, fours: 0, sixes: 0,
    isDismissed: false, didBat: false,
    oversBowled: 0, runsConceded: 0, wickets: 0, maidens: 0,
    lbwBowledWickets: 0,
    catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0,
  });

  const findPlayer = (name) => {
    if (!name) return null;
    // Fuzzy match: try exact, then last-name match
    const clean = name.trim().toLowerCase();
    let player = playersByName.get(clean);
    if (!player) {
      // Try matching by last name
      const lastName = clean.split(' ').pop();
      for (const [key, p] of playersByName) {
        if (key.endsWith(lastName) || key.includes(lastName)) {
          player = p;
          break;
        }
      }
    }
    return player;
  };

  // Process each innings scorecard
  for (const innings of scorecard?.scorecard || []) {
    // Batting
    for (const bat of innings.batting || []) {
      const player = findPlayer(bat.batsman?.name || bat.batsman);
      if (!player) continue;
      const id = String(player._id);
      if (!performances.has(id)) performances.set(id, initPerf(id));
      const perf = performances.get(id);
      perf.didBat = true;
      perf.runs = bat.r ?? bat.runs ?? 0;
      perf.ballsFaced = bat.b ?? bat.balls ?? 0;
      perf.fours = bat['4s'] ?? bat.fours ?? 0;
      perf.sixes = bat['6s'] ?? bat.sixes ?? 0;
      perf.isDismissed = !!(bat.dismissal && bat.dismissal !== 'not out');
    }

    // Bowling
    for (const bowl of innings.bowling || []) {
      const player = findPlayer(bowl.bowler?.name || bowl.bowler);
      if (!player) continue;
      const id = String(player._id);
      if (!performances.has(id)) performances.set(id, initPerf(id));
      const perf = performances.get(id);
      perf.oversBowled = bowl.o ?? bowl.overs ?? 0;
      perf.runsConceded = bowl.r ?? bowl.runs ?? 0;
      perf.wickets = bowl.w ?? bowl.wickets ?? 0;
      perf.maidens = bowl.m ?? bowl.maidens ?? 0;
      // Count LBW/Bowled from wicket descriptions
      perf.lbwBowledWickets = (bowl.wicketDetails || []).filter(
        (d) => /\b(lbw|bowled)\b/i.test(d)
      ).length;
    }

    // Fielding (catches, stumpings, run-outs from dismissal text)
    for (const bat of innings.batting || []) {
      const dismissal = bat.dismissal || '';
      // "c PlayerName b BowlerName"
      const catchMatch = dismissal.match(/^c\s+(.+?)\s+b\s+/i);
      if (catchMatch) {
        const catcher = findPlayer(catchMatch[1]);
        if (catcher) {
          const id = String(catcher._id);
          if (!performances.has(id)) performances.set(id, initPerf(id));
          performances.get(id).catches += 1;
        }
      }
      // "st PlayerName b BowlerName"
      const stumpMatch = dismissal.match(/^st\s+(.+?)\s+b\s+/i);
      if (stumpMatch) {
        const stumper = findPlayer(stumpMatch[1]);
        if (stumper) {
          const id = String(stumper._id);
          if (!performances.has(id)) performances.set(id, initPerf(id));
          performances.get(id).stumpings += 1;
        }
      }
      // "run out (PlayerName)" or "run out (P1/P2)"
      const roMatch = dismissal.match(/run\s+out\s+\((.+?)\)/i);
      if (roMatch) {
        const names = roMatch[1].split('/').map((n) => n.trim());
        if (names.length === 1) {
          const fielder = findPlayer(names[0]);
          if (fielder) {
            const id = String(fielder._id);
            if (!performances.has(id)) performances.set(id, initPerf(id));
            performances.get(id).runOutDirect += 1;
          }
        } else {
          for (const n of names) {
            const fielder = findPlayer(n);
            if (fielder) {
              const id = String(fielder._id);
              if (!performances.has(id)) performances.set(id, initPerf(id));
              performances.get(id).runOutIndirect += 1;
            }
          }
        }
      }
    }
  }

  return Array.from(performances.values());
}

module.exports = { getLiveMatches, getScorecard, getMatchInfo, mapScorecardToPerformances };
