const { Router } = require('express');
const { upsertPrediction, getMatchPredictions, getMyPrediction } = require('../controllers/predictions.controller');
const { authenticate } = require('../middleware/auth.middleware');

const router = Router();
router.use(authenticate);

router.post('/', upsertPrediction);
router.get('/match/:matchId', getMatchPredictions);
router.get('/my/:matchId', getMyPrediction);

module.exports = router;
