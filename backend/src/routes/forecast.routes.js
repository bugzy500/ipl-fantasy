const { Router } = require('express');
const { getLeaderboardForecast, getScenarios } = require('../controllers/forecast.controller');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);
router.get('/:matchId', getLeaderboardForecast);
router.get('/:matchId/scenarios', getScenarios);

module.exports = router;
