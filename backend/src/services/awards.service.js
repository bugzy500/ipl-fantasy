const Award = require('../models/Award.model');
const FantasyTeam = require('../models/FantasyTeam.model');
const { getActiveLeagueMemberIds } = require('./league-members.service');

/**
 * Calculate and store awards after scoring a match.
 * Awards:
 *  - top_scorer: Highest fantasy points in this match
 *  - best_captain: Captain who earned the most multiplied points
 *  - perfect_xi: All 11 selected players were in the playing XI
 *  - underdog_win: Lowest average credit team wins the match
 */
async function calculateAwards(matchId, playerPointsMap, playingXIIds) {
  const activeMemberIds = await getActiveLeagueMemberIds();
  if (activeMemberIds.length === 0) return [];

  const teams = (await FantasyTeam.find({ matchId, userId: { $in: activeMemberIds } })
    .populate('players', 'credits')
    .populate('userId', 'name'))
    .filter((team) => team.userId != null);

  if (teams.length === 0) return [];

  const awards = [];

  // 1. Top Scorer — highest totalPoints
  const sorted = [...teams].sort((a, b) => b.totalPoints - a.totalPoints);
  if (sorted[0] && sorted[0].totalPoints > 0) {
    awards.push({
      matchId,
      type: 'top_scorer',
      userId: sorted[0].userId._id ?? sorted[0].userId,
      value: `${sorted[0].totalPoints} pts`,
      description: 'Highest fantasy points this match',
    });
  }

  // 2. Best Captain Pick — captain who earned most raw points
  let bestCapPoints = 0;
  let bestCapTeam = null;
  for (const team of teams) {
    const capId = String(team.captain);
    const capPts = playerPointsMap[capId] ?? 0;
    if (capPts > bestCapPoints) {
      bestCapPoints = capPts;
      bestCapTeam = team;
    }
  }
  if (bestCapTeam && bestCapPoints > 0) {
    awards.push({
      matchId,
      type: 'best_captain',
      userId: bestCapTeam.userId._id ?? bestCapTeam.userId,
      value: `${bestCapPoints} base pts (2x)`,
      description: 'Best captain pick this match',
    });
  }

  // 3. Perfect XI — all 11 players were in the playing XI
  if (playingXIIds && playingXIIds.length > 0) {
    const playingSet = new Set(playingXIIds.map(String));
    for (const team of teams) {
      const allPlaying = team.players.every((p) => playingSet.has(String(p._id ?? p)));
      if (allPlaying) {
        awards.push({
          matchId,
          type: 'perfect_xi',
          userId: team.userId._id ?? team.userId,
          value: 'All 11 played',
          description: 'All selected players were in the playing XI',
        });
      }
    }
  }

  // 4. Underdog Win — lowest avg credit team has highest points
  if (sorted.length >= 2) {
    const avgCredits = sorted.map((t) => ({
      team: t,
      avg: t.players.reduce((s, p) => s + (p.credits ?? 0), 0) / t.players.length,
    }));
    const cheapest = avgCredits.reduce((a, b) => (a.avg < b.avg ? a : b));
    if (cheapest.team._id.toString() === sorted[0]._id.toString()) {
      awards.push({
        matchId,
        type: 'underdog_win',
        userId: cheapest.team.userId._id ?? cheapest.team.userId,
        value: `Avg ${cheapest.avg.toFixed(1)} credits`,
        description: 'Won with the lowest average credit team',
      });
    }
  }

  // Remove old awards for this match, then insert new ones
  await Award.deleteMany({ matchId });
  if (awards.length > 0) {
    await Award.insertMany(awards);
  }

  return awards;
}

module.exports = { calculateAwards };
