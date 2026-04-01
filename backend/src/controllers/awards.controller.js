const Award = require('../models/Award.model');

// GET /api/awards/match/:matchId
const getMatchAwards = async (req, res) => {
  try {
    const awards = await Award.find({ matchId: req.params.matchId })
      .populate('userId', 'name');
    res.json(awards);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/awards/season — all awards across the season
const getSeasonAwards = async (req, res) => {
  try {
    const awards = await Award.find()
      .populate('userId', 'name')
      .populate('matchId', 'team1 team2 scheduledAt')
      .sort({ createdAt: -1 });
    res.json(awards);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getMatchAwards, getSeasonAwards };
