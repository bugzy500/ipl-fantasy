const mongoose = require('mongoose');

const awardSchema = new mongoose.Schema(
  {
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    type: {
      type: String,
      enum: ['top_scorer', 'best_captain', 'perfect_xi', 'underdog_win'],
      required: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    value: { type: String, default: '' }, // e.g. "156.5 pts" or "All 11 played"
    description: { type: String, default: '' },
  },
  { timestamps: true }
);

awardSchema.index({ matchId: 1 });

module.exports = mongoose.model('Award', awardSchema);
