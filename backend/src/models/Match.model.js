const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema(
  {
    team1: { type: String, required: true },
    team2: { type: String, required: true },
    venue: { type: String, default: '' },
    // scheduledAt = real-life match start time (IST).
    // Supports weekday 7 PM and weekend 3 PM / 7 PM slots.
    scheduledAt: { type: Date, required: true },
    // Deadline auto-set to scheduledAt + 30 minutes
    deadline: { type: Date },
    status: {
      type: String,
      enum: ['upcoming', 'toss_done', 'live', 'completed', 'abandoned'],
      default: 'upcoming',
    },
    // Playing XI announced after toss — array of Player ObjectIds
    playingXI: {
      team1: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
      team2: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
    },
    result: { type: String, default: '' },
    // CricketData.org match ID for live score fetching
    cricApiMatchId: { type: String, default: '' },
  },
  { timestamps: true }
);

// Auto-compute deadline before save
matchSchema.pre('save', function () {
  if (this.isModified('scheduledAt') || !this.deadline) {
    this.deadline = new Date(this.scheduledAt.getTime() + 30 * 60 * 1000);
  }
});

matchSchema.index({ scheduledAt: 1 });
matchSchema.index({ status: 1 });

module.exports = mongoose.model('Match', matchSchema);
