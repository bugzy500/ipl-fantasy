const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth.middleware');

// Per-match awards removed — season category awards served from /api/stats/season-awards
router.use(authenticate);

// Keep season route returning empty for backward compat (frontend may still call it)
router.get('/season', (_req, res) => res.json([]));
router.get('/match/:matchId', (_req, res) => res.json([]));

module.exports = router;
