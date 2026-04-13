const PlayerPerformance = require('../models/PlayerPerformance.model');
const { processPerformances } = require('../services/score-processor.service');
const { buildFantasyPointsBreakdown, getScoringRules } = require('../services/scoring.service');

/**
 * POST /api/scores/:matchId
 * Admin submits raw performance data for all players in a match.
 * Body: { performances: [{ playerId, ...stats }] }
 * The engine calculates fantasy points, then updates all FantasyTeams.
 */
const submitScores = async (req, res) => {
  const { matchId } = req.params;
  const { performances, result: matchResult } = req.body;

  if (!Array.isArray(performances) || performances.length === 0) {
    return res.status(400).json({ message: 'performances array is required' });
  }

  try {
    const result = await processPerformances(matchId, performances, { markCompleted: true, result: matchResult || '' });
    res.json({ message: 'Scores submitted and fantasy teams updated', teamsUpdated: result.teamsUpdated });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : err.message.includes('voided') ? 400 : 500;
    res.status(status).json({ message: err.message });
  }
};

// GET /api/scores/:matchId  — get all player performances for a match
const getScores = async (req, res) => {
  try {
    const performances = await PlayerPerformance.find({ matchId: req.params.matchId })
      .populate('playerId', 'name franchise role imageUrl')
      .lean();

    const withBreakdowns = performances.map((performance) => {
      const scoreBreakdown = buildFantasyPointsBreakdown(performance, performance.playerId?.role ?? 'BAT');
      return {
        ...performance,
        fantasyPoints: scoreBreakdown.total,
        storedFantasyPoints: performance.fantasyPoints,
        scoreBreakdown,
      };
    });

    res.json(withBreakdowns);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getRules = (_req, res) => {
  res.json(getScoringRules());
};

module.exports = { submitScores, getScores, getRules };
