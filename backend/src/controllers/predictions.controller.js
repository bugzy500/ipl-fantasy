const Prediction = require('../models/Prediction.model');
const Match = require('../models/Match.model');

const upsertPrediction = async (req, res) => {
  const { matchId, predictedWinner, predictionType = 'winner' } = req.body;
  try {
    const match = await Match.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (new Date(match.deadline) <= new Date()) {
      return res.status(400).json({ message: 'Deadline has passed' });
    }
    const prediction = await Prediction.findOneAndUpdate(
      { userId: req.user._id, matchId },
      { predictedWinner, predictionType },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json(prediction);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getMatchPredictions = async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (new Date(match.deadline) > new Date()) {
      return res.status(400).json({ message: 'Predictions hidden until deadline' });
    }
    const predictions = await Prediction.find({ matchId: req.params.matchId })
      .populate('userId', 'name');
    res.json(predictions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getMyPrediction = async (req, res) => {
  try {
    const prediction = await Prediction.findOne({
      userId: req.user._id,
      matchId: req.params.matchId,
    });
    res.json(prediction || null);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { upsertPrediction, getMatchPredictions, getMyPrediction };
