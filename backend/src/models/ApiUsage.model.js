const mongoose = require('mongoose');

const apiUsageSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true }, // 'YYYY-MM-DD'
  count: { type: Number, default: 0 },
});

module.exports = mongoose.model('ApiUsage', apiUsageSchema);
