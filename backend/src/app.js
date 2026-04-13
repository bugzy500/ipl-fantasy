require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const authRoutes = require('./routes/auth.routes');
const playerRoutes = require('./routes/players.routes');
const matchRoutes = require('./routes/matches.routes');
const teamRoutes = require('./routes/teams.routes');
const scoreRoutes = require('./routes/scores.routes');
const leaderboardRoutes = require('./routes/leaderboard.routes');
const awardsRoutes = require('./routes/awards.routes');
const { startCronJobs } = require('./services/cron.service');
const cricapiRoutes = require('./routes/cricapi.routes');
const predictionsRoutes = require('./routes/predictions.routes');
const statsRoutes = require('./routes/stats.routes');
const forecastRoutes = require('./routes/forecast.routes');

const app = express();
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:4200')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Security & logging middleware
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS — allow the Angular frontend
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json());

// Health check (used by Render)
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/scores', scoreRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/awards', awardsRoutes);
app.use('/api/cricapi', cricapiRoutes);
app.use('/api/predictions', predictionsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/forecast', forecastRoutes);

// 404 handler
app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// Connect to MongoDB, then start server
const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');

    // Restart CricAPI pollers for any live matches (handles Render spin-down recovery)
    const livePoller = require('./services/live-poller.service');
    livePoller.restartActivePollers();

    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    startCronJobs();
  })
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });
