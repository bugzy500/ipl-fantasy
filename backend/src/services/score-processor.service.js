const PlayerPerformance = require('../models/PlayerPerformance.model');
const FantasyTeam = require('../models/FantasyTeam.model');
const Player = require('../models/Player.model');
const Match = require('../models/Match.model');
const Prediction = require('../models/Prediction.model');
const { calculateFantasyPoints, applyMultiplier } = require('./scoring.service');
const { calculateAwards } = require('./awards.service');
const { evaluatePredictions } = require('./prediction-evaluator.service');

/**
 * Shared scoring pipeline used by both manual admin entry and CricAPI live polling.
 *
 * @param {string} matchId
 * @param {Array}  performances - [{ playerId, runs, ballsFaced, ... }]
 * @param {Object} options
 * @param {boolean} options.markCompleted - if true, sets match to 'completed', locks teams, calculates awards
 * @returns {{ teamsUpdated: number, playerPointsMap: Object }}
 */
async function processPerformances(matchId, performances, { markCompleted = false } = {}) {
  const match = await Match.findById(matchId);
  if (!match) throw new Error('Match not found');
  if (match.status === 'abandoned') throw new Error('Abandoned matches are voided — no points awarded');

  // 1. Calculate and upsert each player's performance + fantasy points
  const playerPointsMap = {}; // { playerId: fantasyPoints }

  for (const perf of performances) {
    const player = await Player.findById(perf.playerId);
    if (!player) continue;

    const fantasyPoints = calculateFantasyPoints(perf, player.role);

    await PlayerPerformance.findOneAndUpdate(
      { playerId: perf.playerId, matchId },
      { ...perf, matchId, fantasyPoints },
      { upsert: true, new: true }
    );

    playerPointsMap[String(perf.playerId)] = fantasyPoints;
  }

  // 2. Recalculate totalPoints for every FantasyTeam in this match
  const teams = await FantasyTeam.find({ matchId });

  for (const team of teams) {
    let totalPoints = 0;

    for (const playerId of team.players) {
      const basePoints = playerPointsMap[String(playerId)] ?? 0;
      const isCaptain = String(team.captain) === String(playerId);
      const isVC = String(team.viceCaptain) === String(playerId);
      totalPoints += applyMultiplier(basePoints, isCaptain, isVC);
    }

    team.totalPoints = Math.round(totalPoints * 10) / 10;
    if (markCompleted) team.isLocked = true;
    await team.save();
  }

  // 3. If finalizing: mark completed + awards + evaluate predictions
  if (markCompleted) {
    match.status = 'completed';
    await match.save();

    const playingXIIds = [
      ...(match.playingXI?.team1 || []),
      ...(match.playingXI?.team2 || []),
    ];
    await calculateAwards(matchId, playerPointsMap, playingXIIds);

    // Evaluate all predictions and award bonus points
    await evaluatePredictions(matchId, match.result);

    // Add prediction bonusPoints to team totalPoints
    const predictions = await Prediction.find({ matchId });
    const predictionsByUser = {}; // userId -> totalBonusPoints
    for (const pred of predictions) {
      const uid = String(pred.userId);
      predictionsByUser[uid] = (predictionsByUser[uid] || 0) + pred.bonusPoints;
    }

    // Update each team's totalPoints with prediction bonuses
    for (const team of teams) {
      const uid = String(team.userId);
      const bonusPoints = predictionsByUser[uid] || 0;
      team.totalPoints = Math.round((team.totalPoints + bonusPoints) * 10) / 10;
      await team.save();
    }
  }

  return { teamsUpdated: teams.length, playerPointsMap };
}

module.exports = { processPerformances };
