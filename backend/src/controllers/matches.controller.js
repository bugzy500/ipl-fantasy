const { validationResult } = require('express-validator');
const Match = require('../models/Match.model');
const Player = require('../models/Player.model');

// GET /api/matches
const getMatches = async (req, res) => {
  try {
    const matches = await Match.find()
      .populate('playingXI.team1', 'name franchise role')
      .populate('playingXI.team2', 'name franchise role')
      .sort({ scheduledAt: 1 });
    res.json(matches);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/matches/:id
const getMatchById = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id)
      .populate('playingXI.team1', 'name franchise role credits imageUrl')
      .populate('playingXI.team2', 'name franchise role credits imageUrl');
    if (!match) return res.status(404).json({ message: 'Match not found' });
    res.json(match);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/matches  (admin) — create a match
const createMatch = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const match = await Match.create(req.body);
    res.status(201).json(match);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/matches/:id  (admin) — update status, announce playing XI, add result
const updateMatch = async (req, res) => {
  try {
    const allowedFields = ['status', 'playingXI', 'result', 'venue', 'deadline', 'cricApiMatchId', 'lastPolledAt', 'pollingEnabled'];
    const updateData = {};
    allowedFields.forEach((f) => { if (req.body[f] !== undefined) updateData[f] = req.body[f]; });

    const match = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true })
      .populate('playingXI.team1', 'name franchise role')
      .populate('playingXI.team2', 'name franchise role');

    if (!match) return res.status(404).json({ message: 'Match not found' });
    res.json(match);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/matches/:id/squad — all players from both franchises (for team builder)
const getMatchSquad = async (req, res) => {
  try {
    const match = await Match.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const players = await Player.find({ franchise: { $in: [match.team1, match.team2] }, isActive: true })
      .sort({ franchise: 1, role: 1, credits: -1 });

    // Mark which players are in playing XI (once announced)
    const playingIds = new Set([
      ...match.playingXI.team1.map(String),
      ...match.playingXI.team2.map(String),
    ]);

    const xiAnnounced = playingIds.size > 0;

    const result = players.map((p) => ({
      ...p.toObject(),
      playingStatus: xiAnnounced
        ? playingIds.has(p._id.toString()) ? 'playing' : 'not_playing'
        : 'unknown',
    }));

    res.json({ match: { id: match._id, team1: match.team1, team2: match.team2, deadline: match.deadline, status: match.status }, players: result });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getMatches, getMatchById, createMatch, updateMatch, getMatchSquad };
