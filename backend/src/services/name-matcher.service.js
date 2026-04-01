const Player = require('../models/Player.model');

let lookupMap = null; // cached { normalizedName → player doc }

function normalize(name) {
  return (name || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function lastName(name) {
  const parts = normalize(name).split(' ');
  return parts[parts.length - 1];
}

/**
 * Build (or rebuild) the in-memory lookup map from all players + aliases.
 * Call once on startup and after player updates.
 */
async function buildLookupMap() {
  const players = await Player.find({ isActive: true });
  const map = new Map();

  for (const p of players) {
    // Index by normalized full name
    map.set(normalize(p.name), p);

    // Index by each alias
    if (p.aliases) {
      for (const alias of p.aliases) {
        map.set(normalize(alias), p);
      }
    }
  }

  lookupMap = map;
  return map;
}

/**
 * Match a CricAPI player name to a local player.
 * @param {string} cricApiName - e.g., "V Kohli" or "Virat Kohli"
 * @param {string} [franchise] - optional franchise hint to narrow matches (e.g., "RCB")
 * @returns {{ playerId: string, playerName: string, confidence: string } | null}
 */
async function matchPlayer(cricApiName, franchise) {
  if (!lookupMap) await buildLookupMap();

  const norm = normalize(cricApiName);

  // 1. Exact match on name or alias
  if (lookupMap.has(norm)) {
    const p = lookupMap.get(norm);
    if (!franchise || p.franchise === franchise) {
      return { playerId: p._id, playerName: p.name, confidence: 'exact' };
    }
  }

  // 2. Last-name + first-initial match
  const cricLast = lastName(cricApiName);
  const cricFirst = norm.split(' ')[0]; // could be an initial like "v"

  const candidates = [];
  for (const [, p] of lookupMap) {
    if (lastName(p.name) !== cricLast) continue;
    if (franchise && p.franchise !== franchise) continue;

    const playerFirst = normalize(p.name).split(' ')[0];
    // Check if CricAPI first name is an initial of our first name
    if (cricFirst.length <= 2 && playerFirst.startsWith(cricFirst[0])) {
      candidates.push({ player: p, score: 0.8 });
    } else if (playerFirst === cricFirst) {
      candidates.push({ player: p, score: 0.95 });
    } else if (playerFirst.startsWith(cricFirst) || cricFirst.startsWith(playerFirst)) {
      candidates.push({ player: p, score: 0.7 });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return { playerId: best.player._id, playerName: best.player.name, confidence: 'fuzzy' };
  }

  // 3. Fallback: last-name only match (lowest confidence, only if unique within franchise)
  const lastNameMatches = [];
  for (const [, p] of lookupMap) {
    if (lastName(p.name) === cricLast && (!franchise || p.franchise === franchise)) {
      lastNameMatches.push(p);
    }
  }
  if (lastNameMatches.length === 1) {
    return { playerId: lastNameMatches[0]._id, playerName: lastNameMatches[0].name, confidence: 'lastname' };
  }

  return null;
}

/**
 * Invalidate the cache (call after player updates).
 */
function invalidateCache() {
  lookupMap = null;
}

module.exports = { buildLookupMap, matchPlayer, invalidateCache };
