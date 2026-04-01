const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const { getMatchAwards, getSeasonAwards } = require('../controllers/awards.controller');

router.use(authenticate);

router.get('/match/:matchId', getMatchAwards);
router.get('/season', getSeasonAwards);

module.exports = router;
