const { Router } = require('express');
const { getSeasonInsights, getSeasonAwards } = require('../controllers/stats.controller');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

router.get('/season-insights', getSeasonInsights);
router.get('/season-awards', getSeasonAwards);

module.exports = router;
