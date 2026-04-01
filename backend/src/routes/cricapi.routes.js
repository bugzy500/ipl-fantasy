const { Router } = require('express');
const {
  linkMatch, startPoll, stopPoll, getPollingStatus,
  syncOnce, previewScorecard, syncImages,
} = require('../controllers/cricapi.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { requireAdmin } = require('../middleware/admin.middleware');

const router = Router();

// All CricAPI routes require admin access
router.use(authenticate);
router.use(requireAdmin);

router.post('/link/:matchId', linkMatch);
router.post('/poll/:matchId/start', startPoll);
router.post('/poll/:matchId/stop', stopPoll);
router.get('/poll/status', getPollingStatus);
router.post('/sync-once/:matchId', syncOnce);
router.get('/preview/:matchId', previewScorecard);
router.post('/sync-images', syncImages);

module.exports = router;
