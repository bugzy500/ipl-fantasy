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

/**
 * Fetch current/recent matches, optionally filtered by offset (pagination).
 * CricAPI returns ~10 matches per page.
 */
async function getCurrentMatches(offset = 0) {
  return apiGet('currentMatches', { offset: String(offset) });
}

/**
 * Search matches by series. CricAPI v1/series_info returns matches in a series.
 */
async function getSeriesMatches(seriesId) {
  return apiGet('series_info', { id: seriesId });
}

// ── Team Name Mapping ─────────────────────────────────────────────────────────

const TEAM_NAME_TO_ABBR = {
  'chennai super kings': 'CSK',
  'mumbai indians': 'MI',
  'royal challengers bengaluru': 'RCB',
  'royal challengers bangalore': 'RCB',
  'kolkata knight riders': 'KKR',
  'sunrisers hyderabad': 'SRH',
  'rajasthan royals': 'RR',
  'punjab kings': 'PBKS',
  'delhi capitals': 'DC',
  'gujarat titans': 'GT',
  'lucknow super giants': 'LSG',
};

/**
 * Convert a CricAPI full team name to our local abbreviation.
 * e.g., "Chennai Super Kings" → "CSK"
 */
function teamNameToAbbr(fullName) {
  if (!fullName) return null;
  return TEAM_NAME_TO_ABBR[fullName.toLowerCase().trim()] || null;
}

/**
 * Try to auto-match CricAPI matches to local unlinked matches.
 * Matches by: both team abbreviations match AND same date (IST).
 * Returns array of { localMatchId, cricApiMatchId, team1, team2, date }.
 */
async function autoLinkMatches() {
  const Match = require('../models/Match.model');

  // Get local matches that don't have a CricAPI ID yet
  const unlinked = await Match.find({ cricApiMatchId: '' }).sort({ scheduledAt: 1 });
  if (unlinked.length === 0) return { linked: 0, results: [] };

  // Fetch current matches from CricAPI (multiple pages to catch more)
  let cricApiMatches = [];
  for (let offset = 0; offset <= 10; offset += 10) {
    try {
      const res = await getCurrentMatches(offset);
      if (res.data && Array.isArray(res.data)) {
        cricApiMatches.push(...res.data);
      }
      // Stop if less than a full page
      if (!res.data || res.data.length < 10) break;
    } catch (err) {
      if (err.message.includes('RATE_LIMITED')) break;
      console.log(`[AutoLink] Page offset ${offset} failed:`, err.message);
      break;
    }
  }

  // Filter to IPL matches only (name contains "IPL" or "Indian Premier League")
  const iplMatches = cricApiMatches.filter((m) => {
    const name = (m.name || m.series || '').toLowerCase();
    return name.includes('ipl') || name.includes('indian premier league');
  });

  const results = [];
  for (const cricMatch of iplMatches) {
    // Resolve CricAPI team names to abbreviations
    const t1Abbr = teamNameToAbbr(cricMatch.teamInfo?.[0]?.name || cricMatch.teams?.[0]);
    const t2Abbr = teamNameToAbbr(cricMatch.teamInfo?.[1]?.name || cricMatch.teams?.[1]);
    if (!t1Abbr || !t2Abbr) continue;

    // CricAPI match date
    const cricDate = cricMatch.date ? new Date(cricMatch.date) : null;
    const cricDateStr = cricDate ? cricDate.toISOString().slice(0, 10) : null;

    // Find matching local match (same teams, same date)
    for (const local of unlinked) {
      if (local.cricApiMatchId) continue; // already linked in this batch
      const localDateStr = local.scheduledAt.toISOString().slice(0, 10);

      const teamsMatch =
        (local.team1 === t1Abbr && local.team2 === t2Abbr) ||
        (local.team1 === t2Abbr && local.team2 === t1Abbr);

      if (teamsMatch && localDateStr === cricDateStr) {
        local.cricApiMatchId = cricMatch.id;
        await local.save();

        results.push({
          localMatchId: local._id,
          cricApiMatchId: cricMatch.id,
          teams: `${local.team1} vs ${local.team2}`,
          date: localDateStr,
        });
        break; // move to next CricAPI match
      }
    }
  }

  return { linked: results.length, results };
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
        lbwBowledWickets: 0, dotBalls: 0,
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
        p.dotBalls = (b["0s"] ?? b.d ?? b.dots ?? 0);

        // Extract player image
        const img = b.bowler?.img || b.img;
        if (img) images[name] = img;
      }
    }
  }

  // ── Fielding name resolution ──
  // Dismissal strings use partial names ("c Bumrah b Boult") but batting/bowling
  // sections have full names ("Jasprit Bumrah"). Resolve partial fielding names
  // to existing full-name entries before creating new orphan entries.
  const knownNames = Object.keys(playerMap);

  function resolveFielderName(partialName) {
    // Already an exact key in playerMap
    if (playerMap[partialName]) return partialName;

    const partial = partialName.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const partialParts = partial.split(' ');
    const partialLast = partialParts[partialParts.length - 1];
    const partialFirst = partialParts.length > 1 ? partialParts[0] : null;

    // Score each known name — higher score = better match
    let bestMatch = null;
    let bestScore = 0;
    let tieCount = 0;

    for (const full of knownNames) {
      const fullLower = full.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
      const fullParts = fullLower.split(' ');
      const fullLast = fullParts[fullParts.length - 1];

      if (fullLast !== partialLast) continue;

      let score = 1; // base: last name matches

      if (partialFirst) {
        const fullFirst = fullParts[0];
        if (partialFirst === fullFirst) {
          score = 4; // exact first name match ("rohit" == "rohit")
        } else if (partialFirst.length <= 2 && fullFirst.startsWith(partialFirst[0])) {
          score = 3; // initial match ("r" matches "rohit")
        } else if (fullFirst.startsWith(partialFirst) || partialFirst.startsWith(fullFirst)) {
          score = 2; // prefix match ("rash" matches "rashid")
        } else {
          continue; // first name given but doesn't match — skip
        }
      }

      if (score > bestScore) {
        bestMatch = full;
        bestScore = score;
        tieCount = 1;
      } else if (score === bestScore) {
        tieCount++;
      }
    }

    // Only resolve if there's exactly one best match (no ambiguity)
    return (bestMatch && tieCount === 1) ? bestMatch : partialName;
  }

  // Process fielding from dismissals
  for (const d of allDismissals) {
    if (d.type === 'caught' && d.catcher) {
      getOrInit(resolveFielderName(d.catcher)).catches++;
    }
    if (d.type === 'stumped' && d.keeper) {
      getOrInit(resolveFielderName(d.keeper)).stumpings++;
    }
    if (d.type === 'runout_direct' && d.fielders) {
      for (const f of d.fielders) getOrInit(resolveFielderName(f)).runOutDirect++;
    }
    if (d.type === 'runout_indirect' && d.fielders) {
      for (const f of d.fielders) getOrInit(resolveFielderName(f)).runOutIndirect++;
    }
    // Count LBW/bowled wickets for the bowler
    if ((d.type === 'lbw' || d.type === 'bowled') && d.bowler) {
      getOrInit(resolveFielderName(d.bowler)).lbwBowledWickets++;
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
    matchStatus: data.status || '',
    images,
  };
}

/**
 * Convert a CricAPI result string to local format by replacing full team names with abbreviations.
 * e.g., "Chennai Super Kings won by 5 wickets" → "CSK won by 5 wickets"
 */
function convertResultToLocal(resultStr) {
  if (!resultStr) return '';
  let result = resultStr;
  for (const [fullName, abbr] of Object.entries(TEAM_NAME_TO_ABBR)) {
    const regex = new RegExp(fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, abbr);
  }
  return result;
}

module.exports = {
  getMatchScorecard,
  getMatchInfo,
  getCurrentMatches,
  getSeriesMatches,
  mapScorecardToPerformances,
  getUsageToday,
  canMakeRequest,
  convertOvers,
  parseDismissal,
  teamNameToAbbr,
  convertResultToLocal,
  autoLinkMatches,
};
