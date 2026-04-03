const { Router } = require('express');
const { submitScores, getScores, getRules } = require('../controllers/scores.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireAdmin } = require('../middleware/admin.middleware');

const router = Router();

router.use(authenticate);

router.get('/rules', getRules);
router.get('/:matchId', getScores);
router.post('/:matchId', requireAdmin, submitScores);

module.exports = router;
