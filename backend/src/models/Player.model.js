const mongoose = require('mongoose');

// IPL 2026 franchises
const FRANCHISES = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'PBKS', 'DC', 'GT', 'LSG'];

const playerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    franchise: { type: String, required: true, enum: FRANCHISES },
    role: { type: String, required: true, enum: ['WK', 'BAT', 'AR', 'BOWL'] },
    credits: { type: Number, required: true, min: 5, max: 15 },
    imageUrl: { type: String, default: '' },
    aliases: [{ type: String }], // alternate names for CricAPI matching (e.g., "V Kohli")
    isActive: { type: Boolean, default: true }, // false = injured/unavailable for season
  },
  { timestamps: true }
);

playerSchema.index({ franchise: 1, role: 1 });

module.exports = mongoose.model('Player', playerSchema);
