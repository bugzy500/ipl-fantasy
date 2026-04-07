const mongoose = require('mongoose');

const playerPerformanceSchema = new mongoose.Schema(
  {
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },

    // Batting
    runs: { type: Number, default: 0 },
    ballsFaced: { type: Number, default: 0 },
    fours: { type: Number, default: 0 },
    sixes: { type: Number, default: 0 },
    isDismissed: { type: Boolean, default: false }, // did they bat and get out?
    didBat: { type: Boolean, default: false },       // did they bat at all?

    // Bowling
    oversBowled: { type: Number, default: 0 },
    runsConceded: { type: Number, default: 0 },
    wickets: { type: Number, default: 0 },
    maidens: { type: Number, default: 0 },
    lbwBowledWickets: { type: Number, default: 0 }, // wickets that were LBW or Bowled (for bonus)
    dotBalls: { type: Number, default: 0 }, // dot balls bowled (+2 pts each)

    // Fielding
    catches: { type: Number, default: 0 },
    stumpings: { type: Number, default: 0 },
    runOutDirect: { type: Number, default: 0 },
    runOutIndirect: { type: Number, default: 0 }, // non-direct throw OR catch count

    // Computed by scoring service
    fantasyPoints: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One performance record per player per match
playerPerformanceSchema.index({ playerId: 1, matchId: 1 }, { unique: true });

module.exports = mongoose.model('PlayerPerformance', playerPerformanceSchema);
