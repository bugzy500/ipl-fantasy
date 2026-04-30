const PlayerPerformance = require('../models/PlayerPerformance.model');
const FantasyTeam = require('../models/FantasyTeam.model');
const Player = require('../models/Player.model');
const Match = require('../models/Match.model');
const Prediction = require('../models/Prediction.model');
const { calculateFantasyPoints, applyMultiplier, buildFantasyPointsBreakdown } = require('./scoring.service');
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
async function processPerformances(matchId, performances, { markCompleted = false, result = '' } = {}) {
  const match = await Match.findById(matchId);
  if (!match) throw new Error('Match not found');
  if (match.status === 'abandoned') throw new Error('Abandoned matches are voided — no points awarded');

  // 1a. Merge duplicate performances that resolved to the same playerId.
  //     Prevents the overwrite bug where an orphan fielding entry (catches only)
  //     and a full batting entry both resolve to the same player — the second upsert
  //     would nuke the first's data. Merge: max for batting/bowling, sum for fielding.
  const mergedByPlayer = new Map();

  for (const perf of performances) {
    const pid = String(perf.playerId);
    if (!mergedByPlayer.has(pid)) {
      mergedByPlayer.set(pid, { ...perf });
    } else {
      const existing = mergedByPlayer.get(pid);
      existing.runs = Math.max(existing.runs || 0, perf.runs || 0);
      existing.ballsFaced = Math.max(existing.ballsFaced || 0, perf.ballsFaced || 0);
      existing.fours = Math.max(existing.fours || 0, perf.fours || 0);
      existing.sixes = Math.max(existing.sixes || 0, perf.sixes || 0);
      existing.didBat = existing.didBat || perf.didBat || false;
      existing.isDismissed = existing.isDismissed || perf.isDismissed || false;
      existing.oversBowled = Math.max(existing.oversBowled || 0, perf.oversBowled || 0);
      existing.runsConceded = Math.max(existing.runsConceded || 0, perf.runsConceded || 0);
      existing.wickets = Math.max(existing.wickets || 0, perf.wickets || 0);
      existing.maidens = Math.max(existing.maidens || 0, perf.maidens || 0);
      existing.lbwBowledWickets = Math.max(existing.lbwBowledWickets || 0, perf.lbwBowledWickets || 0);
      existing.dotBalls = Math.max(existing.dotBalls || 0, perf.dotBalls || 0);
      existing.catches = (existing.catches || 0) + (perf.catches || 0);
      existing.stumpings = (existing.stumpings || 0) + (perf.stumpings || 0);
      existing.runOutDirect = (existing.runOutDirect || 0) + (perf.runOutDirect || 0);
      existing.runOutIndirect = (existing.runOutIndirect || 0) + (perf.runOutIndirect || 0);
    }
  }

  // 1b. Calculate and upsert each merged player performance
  const playerPointsMap = {};

  for (const [, perf] of mergedByPlayer) {
    const player = await Player.findById(perf.playerId);
    if (!player) continue;

    const scoreBreakdown = buildFantasyPointsBreakdown(perf, player.role);
    const fantasyPoints = scoreBreakdown.total;

    await PlayerPerformance.findOneAndUpdate(
      { playerId: perf.playerId, matchId },
      { ...perf, matchId, fantasyPoints, scoreBreakdown },
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
    // Persist result string if provided (manual admin path).
    // Live poller sets match.result before calling us; admin form passes it in options.
    if (result) match.result = result;
    match.status = 'completed';
    await match.save();

    const playingXIIds = [
      ...(match.playingXI?.team1 || []),
      ...(match.playingXI?.team2 || []),
    ];
    // Per-match awards removed — season category awards are calculated dynamically
    // await calculateAwards(matchId, playerPointsMap, playingXIIds);

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
