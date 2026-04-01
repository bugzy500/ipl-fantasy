const PlayerPerformance = require('../models/PlayerPerformance.model');
const { processPerformances } = require('../services/score-processor.service');

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
    const result = await processPerformances(matchId, performances, { markCompleted: true });
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
      .populate('playerId', 'name franchise role imageUrl');
    res.json(performances);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { submitScores, getScores };
