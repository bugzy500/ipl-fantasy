const { Router } = require('express');
const { getSeasonInsights } = require('../controllers/stats.controller');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

router.get('/season-insights', getSeasonInsights);

module.exports = router;
