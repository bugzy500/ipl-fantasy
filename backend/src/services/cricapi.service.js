const ApiUsage = require('../models/ApiUsage.model');
const Player = require('../models/Player.model');

const BASE_URL = 'https://api.cricapi.com/v1';
const DAILY_LIMIT = 100;
const HARD_CAP = 95; // reserve 5 for manual admin actions

function getApiKey() {
  const key = process.env.CRICAPI_KEY;
  if (!key) throw new Error('CRICAPI_KEY not set in environment');
  return key;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Rate Limit Tracking ──────────────────────────────────────────────────────

async function getUsageToday() {
  const doc = await ApiUsage.findOneAndUpdate(
    { date: todayStr() },
    { $setOnInsert: { count: 0 } },
    { upsert: true, new: true }
  );
  return doc.count;
}

async function incrementUsage() {
  await ApiUsage.findOneAndUpdate(
    { date: todayStr() },
    { $inc: { count: 1 } },
    { upsert: true }
  );
}

async function canMakeRequest() {
  const used = await getUsageToday();
  return used < HARD_CAP;
}

// ── API Calls ────────────────────────────────────────────────────────────────

async function apiGet(endpoint, params = {}) {
  if (!(await canMakeRequest())) {
    throw new Error('RATE_LIMITED: Daily CricAPI call limit reached');
  }

  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('apikey', getApiKey());
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  await incrementUsage();
  const res = await fetch(url.toString());

  if (!res.ok) {
    if (res.status === 429) throw new Error('RATE_LIMITED: CricAPI 429');
    if (res.status === 401) throw new Error('AUTH_FAILED: Invalid CricAPI key');
    throw new Error(`CRICAPI_ERROR: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.status !== 'success') {
    throw new Error(`CRICAPI_ERROR: ${json.info || 'Unknown error'}`);
  }

  return json;
}

async function getMatchScorecard(cricApiMatchId) {
  return apiGet('match_scorecard', { id: cricApiMatchId });
}

async function getMatchInfo(cricApiMatchId) {
  return apiGet('match_info', { id: cricApiMatchId });
}

// ── Overs Conversion ─────────────────────────────────────────────────────────

/**
 * Convert cricket overs notation to actual overs.
 * 3.4 (3 overs, 4 balls) → 3 + 4/6 = 3.667
 */
function convertOvers(cricketOvers) {
  if (!cricketOvers || cricketOvers === 0) return 0;
  const whole = Math.floor(cricketOvers);
  const balls = Math.round((cricketOvers - whole) * 10);
  return whole + balls / 6;
}

// ── Dismissal Parsing ────────────────────────────────────────────────────────

/**
 * Parse a dismissal string to extract fielding contributions.
 * Examples:
 *   "c Bumrah b Boult"       → { type: 'caught', catcher: 'Bumrah', bowler: 'Boult' }
 *   "b Bumrah"               → { type: 'bowled', bowler: 'Bumrah' }
 *   "lbw b Chahal"           → { type: 'lbw', bowler: 'Chahal' }
 *   "st Dhoni b Jadeja"      → { type: 'stumped', keeper: 'Dhoni', bowler: 'Jadeja' }
 *   "run out (Jadeja)"       → { type: 'runout_direct', fielders: ['Jadeja'] }
 *   "run out (Jadeja/Dhoni)" → { type: 'runout_indirect', fielders: ['Jadeja', 'Dhoni'] }
 *   "not out"                → { type: 'not_out' }
 */
function parseDismissal(str) {
  if (!str || str === 'not out' || str === '' || str === '-') {
    return { type: 'not_out' };
  }

  const s = str.trim();

  // Run out
  const runOutMatch = s.match(/run out \(([^)]+)\)/i);
  if (runOutMatch) {
    const fielders = runOutMatch[1].split('/').map((f) => f.trim());
    return {
      type: fielders.length === 1 ? 'runout_direct' : 'runout_indirect',
      fielders,
    };
  }

  // Stumped: "st KeeperName b BowlerName"
  const stMatch = s.match(/^st\s+(.+?)\s+b\s+(.+)$/i);
  if (stMatch) {
    return { type: 'stumped', keeper: stMatch[1].trim(), bowler: stMatch[2].trim() };
  }

  // Caught: "c FielderName b BowlerName" OR "c & b BowlerName"
  const cAndBMatch = s.match(/^c\s*&\s*b\s+(.+)$/i);
  if (cAndBMatch) {
    const bowler = cAndBMatch[1].trim();
    return { type: 'caught', catcher: bowler, bowler };
  }
  const cMatch = s.match(/^c\s+(.+?)\s+b\s+(.+)$/i);
  if (cMatch) {
    return { type: 'caught', catcher: cMatch[1].trim(), bowler: cMatch[2].trim() };
  }

  // LBW: "lbw b BowlerName"
  const lbwMatch = s.match(/^lbw\s+b\s+(.+)$/i);
  if (lbwMatch) {
    return { type: 'lbw', bowler: lbwMatch[1].trim() };
  }

  // Bowled: "b BowlerName"
  const bMatch = s.match(/^b\s+(.+)$/i);
  if (bMatch) {
    return { type: 'bowled', bowler: bMatch[1].trim() };
  }

  // Hit wicket, timed out, retired, etc
  return { type: 'other', raw: s };
}

// ── Scorecard → PlayerPerformance Mapping ────────────────────────────────────

/**
 * Maps a CricAPI scorecard response into an array matching our PlayerPerformance schema.
 * Returns: [{ cricApiName, franchise?, ...stats }] — playerIds resolved separately by name-matcher.
 */
function mapScorecardToPerformances(scorecardData) {
  const data = scorecardData?.data;
  if (!data) return { performances: [], matchEnded: false, images: {} };

  const scorecard = data.scorecard || [];
  const playerMap = {}; // key: cricApiName → merged stats
  const images = {};    // key: cricApiName → imageUrl

  // Helper to init a player entry
  const getOrInit = (name) => {
    if (!playerMap[name]) {
      playerMap[name] = {
        cricApiName: name,
        runs: 0, ballsFaced: 0, fours: 0, sixes: 0,
        didBat: false, isDismissed: false,
        oversBowled: 0, runsConceded: 0, wickets: 0, maidens: 0,
        lbwBowledWickets: 0,
        catches: 0, stumpings: 0, runOutDirect: 0, runOutIndirect: 0,
      };
    }
    return playerMap[name];
  };

  // Collect all dismissal strings for LBW/bowled counting per bowler
  const allDismissals = [];

  for (const inning of scorecard) {
    // Process batting
    if (inning.batting) {
      for (const b of inning.batting) {
        const name = b.batsman?.name || b.name;
        if (!name) continue;

        const p = getOrInit(name);
        p.didBat = true;
        p.runs = (b.r ?? b.runs ?? 0);
        p.ballsFaced = (b.b ?? b.balls ?? 0);
        p.fours = (b['4s'] ?? b.fours ?? 0);
        p.sixes = (b['6s'] ?? b.sixes ?? 0);

        const dismissal = b.dismissal || b['dismissal-text'] || '';
        const parsed = parseDismissal(dismissal);
        p.isDismissed = parsed.type !== 'not_out';

        // Collect dismissal for fielding analysis
        if (parsed.type !== 'not_out') {
          allDismissals.push(parsed);
        }

        // Extract player image if available
        const img = b.batsman?.img || b.img;
        if (img) images[name] = img;
      }
    }

    // Process bowling
    if (inning.bowling) {
      for (const b of inning.bowling) {
        const name = b.bowler?.name || b.name;
        if (!name) continue;

        const p = getOrInit(name);
        p.oversBowled = convertOvers(b.o ?? b.overs ?? 0);
        p.runsConceded = (b.r ?? b.runs ?? 0);
        p.wickets = (b.w ?? b.wickets ?? 0);
        p.maidens = (b.m ?? b.maidens ?? 0);

        // Extract player image
        const img = b.bowler?.img || b.img;
        if (img) images[name] = img;
      }
    }
  }

  // Process fielding from dismissals
  for (const d of allDismissals) {
    if (d.type === 'caught' && d.catcher) {
      getOrInit(d.catcher).catches++;
    }
    if (d.type === 'stumped' && d.keeper) {
      getOrInit(d.keeper).stumpings++;
    }
    if (d.type === 'runout_direct' && d.fielders) {
      for (const f of d.fielders) getOrInit(f).runOutDirect++;
    }
    if (d.type === 'runout_indirect' && d.fielders) {
      for (const f of d.fielders) getOrInit(f).runOutIndirect++;
    }
    // Count LBW/bowled wickets for the bowler
    if ((d.type === 'lbw' || d.type === 'bowled') && d.bowler) {
      getOrInit(d.bowler).lbwBowledWickets++;
    }
  }

  // Determine if match has ended
  const matchEnded = !!(
    data.matchEnded ||
    data.status === 'Match over' ||
    data.matchWinner
  );

  return {
    performances: Object.values(playerMap),
    matchEnded,
    images,
  };
}

module.exports = {
  getMatchScorecard,
  getMatchInfo,
  mapScorecardToPerformances,
  getUsageToday,
  canMakeRequest,
  convertOvers,
  parseDismissal,
};
