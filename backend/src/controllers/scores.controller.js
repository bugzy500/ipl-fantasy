const PlayerPerformance = require('../models/PlayerPerformance.model');
const FantasyTeam = require('../models/FantasyTeam.model');
const Player = require('../models/Player.model');
const Match = require('../models/Match.model');
const { calculateFantasyPoints, applyMultiplier } = require('../services/scoring.service');
const { calculateAwards } = require('../services/awards.service');

/**
 * POST /api/scores/:matchId
 * Admin submits raw performance data for all players in a match.
 * Body: { performances: [{ playerId, ...stats }] }
 * The engine calculates fantasy points, then updates all FantasyTeams.
 */
const submitScores = async (req, res) => {
  const { matchId } = req.params;
  const { performances } = req.body;

  if (!Array.isArray(performances) || performances.length === 0) {
    return res.status(400).json({ message: 'performances array is required' });
  }

  try {
    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.status === 'abandoned') {
      return res.status(400).json({ message: 'Abandoned matches are voided — no points awarded' });
    }

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

      team.totalPoints = Math.round(totalPoints * 10) / 10; // 1 decimal place
      team.isLocked = true;
      await team.save();
    }

    // 3. Mark match as completed
    match.status = 'completed';
    await match.save();

    // 4. Calculate awards for this match
    const playingXIIds = [...(match.playingXI?.team1 || []), ...(match.playingXI?.team2 || [])];
    await calculateAwards(matchId, playerPointsMap, playingXIIds);

    res.json({ message: 'Scores submitted and fantasy teams updated', teamsUpdated: teams.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/scores/:matchId  — get all player performances for a match
const getScores = async (req, res) => {
  try {
    const performances = await PlayerPerformance.find({ matchId: req.params.matchId })
      .populate('playerId', 'name franchise role imageUrl');
    res.json(performances);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { submitScores, getScores };
