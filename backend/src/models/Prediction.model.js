const mongoose = require('mongoose');

const predictionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
  predictedWinner: { type: String, enum: ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'PBKS', 'DC', 'GT', 'LSG'], required: true },
  predictionType: { type: String, enum: ['winner', 'superover'], default: 'winner' }, // winner: +10 pts, superover: +20 pts
  isCorrect: { type: Boolean, default: null }, // null = pending, true/false after match
  bonusPoints: { type: Number, default: 0 }, // +10 if correct (winner), +20 if correct (superover)
}, { timestamps: true });

predictionSchema.index({ userId: 1, matchId: 1 }, { unique: true });

module.exports = mongoose.model('Prediction', predictionSchema);
