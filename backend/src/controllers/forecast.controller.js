const { generateForecast, generateScenarios } = require('../services/leaderboard-forecast.service');

const getLeaderboardForecast = async (req, res) => {
  try {
    const forecast = await generateForecast(req.params.matchId);
    res.json(forecast);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getScenarios = async (req, res) => {
  try {
    const scenarios = await generateScenarios(req.params.matchId);
    res.json(scenarios);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getLeaderboardForecast, getScenarios };
