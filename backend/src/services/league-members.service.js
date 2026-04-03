const League = require('../models/League.model');

const ACTIVE_SEASON = process.env.LEAGUE_SEASON || 'IPL_2026';

async function getActiveLeague() {
  return League.findOne({ season: ACTIVE_SEASON }).sort({ createdAt: -1 }).select('members');
}

async function getActiveLeagueMemberIds() {
  const league = await getActiveLeague();
  return league?.members ?? [];
}

async function getActiveLeagueMemberIdSet() {
  return new Set((await getActiveLeagueMemberIds()).map((id) => String(id)));
}

module.exports = { ACTIVE_SEASON, getActiveLeague, getActiveLeagueMemberIds, getActiveLeagueMemberIdSet };
