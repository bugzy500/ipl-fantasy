const { Router } = require('express');
const { body } = require('express-validator');
const { getMatches, getMatchById, createMatch, updateMatch, getMatchSquad, getMatchFantasyPicks } = require('../controllers/matches.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireAdmin } = require('../middleware/admin.middleware');

const router = Router();

router.use(authenticate);

router.get('/', getMatches);
router.get('/:id', getMatchById);
router.get('/:id/squad', getMatchSquad);
router.get('/:id/fantasy-picks', getMatchFantasyPicks);

router.post(
  '/',
  requireAdmin,
  [
    body('team1').notEmpty(),
    body('team2').notEmpty(),
    body('scheduledAt').isISO8601().withMessage('scheduledAt must be a valid ISO date'),
  ],
  createMatch
);

router.patch('/:id', requireAdmin, updateMatch);

module.exports = router;
