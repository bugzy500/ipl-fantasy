/**
 * CricketData.org API Integration
 * Free tier: 100 hits/day — poll smartly.
 *
 * Base URL: https://api.cricapi.com/v1
 * Env: CRICKET_DATA_API_KEY
 */
const Match = require('../models/Match.model');

const BASE_URL = 'https://api.cricapi.com/v1';

function apiKey() {
  return process.env.CRICKET_DATA_API_KEY;
}

async function apiFetch(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('apikey', apiKey());
  url.searchParams.set('offset', '0');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`CricketData API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`CricketData API error: ${data.info || JSON.stringify(data)}`);
  return data;
}

/**
 * Get current live matches (IPL filter)
 */
async function getLiveMatches() {
  const data = await apiFetch('currentMatches');
  return (data.data || []).filter(
    (m) => m.matchType === 't20' && (m.name || '').toLowerCase().includes('ipl')
  );
}

/**
 * Get scorecard for a specific match.
 * Response shape:
 *   data.scorecard[] = innings, each with:
 *     batting[]: { batsman: {id, name}, r, b, 4s, 6s, sr, dismissal, bowler: {id, name} }
 *     bowling[]: { bowler: {id, name}, o, m, r, w, eco }
 *     catching[]: { catcher: {id, name}, catch, stumped, runout }
 */
async function getScorecard(cricApiMatchId) {
  const data = await apiFetch('match_scorecard', { id: cricApiMatchId });
  return data.data;
}

/**
 * Get match info (playing XI via squad endpoint)
 */
async function getMatchSquad(cricApiMatchId) {
  const data = await apiFetch('match_squad', { id: cricApiMatchId });
  return data.data; // array of { teamName, players[] }
}

/**
 * Get match info (toss, status, winner)
 */
async function getMatchInfo(cricApiMatchId) {
  const data = await apiFetch('match_info', { id: cricApiMatchId });
  return data.data;
}

/**
 * Map CricketData scorecard to our PlayerPerformance format.
 * Uses real API field names: r, b, 4s, 6s, o, m, w, dismissal, catching array.
 *
 * @param {Object} scorecard - data from getScorecard()
 * @param {Map<string, Object>} playersByName - lowercase name -> Player doc
 * @returns {Array} performances array matching PlayerPerformance schema
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

  const findPlayer = (nameOrObj) => {
    if (!nameOrObj) return null;
    const name = typeof nameOrObj === 'object' ? nameOrObj.name : nameOrObj;
    if (!name) return null;
    const clean = name.trim().toLowerCase();

    // Exact match
    let player = playersByName.get(clean);
    if (player) return player;

    // Last name match
    const lastName = clean.split(' ').pop();
    for (const [key, p] of playersByName) {
      if (key.endsWith(lastName) || key.includes(lastName)) return p;
    }
    return null;
  };

  const getOrInit = (playerId) => {
    const id = String(playerId);
    if (!performances.has(id)) performances.set(id, initPerf(id));
    return performances.get(id);
  };

  for (const innings of scorecard?.scorecard || []) {
    // ── Batting ──
    for (const bat of innings.batting || []) {
      const player = findPlayer(bat.batsman);
      if (!player) continue;
      const perf = getOrInit(player._id);
      perf.didBat = true;
      perf.runs = bat.r ?? 0;
      perf.ballsFaced = bat.b ?? 0;
      perf.fours = bat['4s'] ?? 0;
      perf.sixes = bat['6s'] ?? 0;
      perf.isDismissed = !!(bat.dismissal && bat.dismissal.toLowerCase() !== 'not out');

      // Check if dismissal was LBW or Bowled (credit the bowler)
      if (bat.dismissal && /\b(lbw|bowled)\b/i.test(bat.dismissal) && bat.bowler) {
        const bowler = findPlayer(bat.bowler);
        if (bowler) {
          const bowlerPerf = getOrInit(bowler._id);
          bowlerPerf.lbwBowledWickets += 1;
        }
      }
    }

    // ── Bowling ──
    for (const bowl of innings.bowling || []) {
      const player = findPlayer(bowl.bowler);
      if (!player) continue;
      const perf = getOrInit(player._id);
      perf.oversBowled = bowl.o ?? 0;
      perf.runsConceded = bowl.r ?? 0;
      perf.wickets = bowl.w ?? 0;
      perf.maidens = bowl.m ?? 0;
    }

    // ── Fielding (from catching array) ──
    for (const field of innings.catching || []) {
      const player = findPlayer(field.catcher);
      if (!player) continue;
      const perf = getOrInit(player._id);
      perf.catches += field.catch ?? 0;
      perf.stumpings += field.stumped ?? 0;
      // API gives total runout count; treat as direct if 1, indirect split not available
      const runouts = field.runout ?? 0;
      perf.runOutDirect += runouts;
    }
  }

  return Array.from(performances.values());
}

module.exports = { getLiveMatches, getScorecard, getMatchSquad, getMatchInfo, mapScorecardToPerformances };
