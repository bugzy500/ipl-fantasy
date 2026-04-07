const { Router } = require('express');
const { submitScores, getScores, getRules } = require('../controllers/scores.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireAdmin } = require('../middleware/admin.middleware');

const router = Router();

// Public — scoring rules are visible to everyone (no login required)
router.get('/rules', getRules);

router.use(authenticate);

router.get('/:matchId', getScores);
router.post('/:matchId', requireAdmin, submitScores);

module.exports = router;
