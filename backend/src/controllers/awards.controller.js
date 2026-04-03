const Award = require('../models/Award.model');
const { getActiveLeagueMemberIds } = require('../services/league-members.service');

// GET /api/awards/match/:matchId
const getMatchAwards = async (req, res) => {
  try {
    const activeMemberIds = await getActiveLeagueMemberIds();
    if (activeMemberIds.length === 0) return res.json([]);

    const awards = await Award.find({ matchId: req.params.matchId, userId: { $in: activeMemberIds } })
      .populate('userId', 'name');
    res.json(awards.filter((award) => award.userId != null));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/awards/season — all awards across the season
const getSeasonAwards = async (req, res) => {
  try {
    const activeMemberIds = await getActiveLeagueMemberIds();
    if (activeMemberIds.length === 0) return res.json([]);

    const awards = await Award.find({ userId: { $in: activeMemberIds } })
      .populate('userId', 'name')
      .populate('matchId', 'team1 team2 scheduledAt')
      .sort({ createdAt: -1 });
    res.json(awards.filter((award) => award.userId != null));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getMatchAwards, getSeasonAwards };
