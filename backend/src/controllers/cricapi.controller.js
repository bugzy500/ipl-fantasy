const Match = require('../models/Match.model');
const Player = require('../models/Player.model');
const { getMatchScorecard, mapScorecardToPerformances, getUsageToday, autoLinkMatches } = require('../services/cricapi.service');
const { matchPlayer, buildLookupMap } = require('../services/name-matcher.service');
const { processPerformances } = require('../services/score-processor.service');
const livePoller = require('../services/live-poller.service');

// POST /api/cricapi/link/:matchId — link a CricAPI match ID
const linkMatch = async (req, res) => {
  const { cricApiMatchId } = req.body;
  if (!cricApiMatchId) return res.status(400).json({ message: 'cricApiMatchId is required' });

  try {
    const match = await Match.findByIdAndUpdate(
      req.params.matchId,
      { cricApiMatchId },
      { new: true }
    );
    if (!match) return res.status(404).json({ message: 'Match not found' });
    res.json({ message: 'CricAPI match linked', cricApiMatchId: match.cricApiMatchId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/cricapi/poll/:matchId/start — start live polling
const startPoll = async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (!match.cricApiMatchId) return res.status(400).json({ message: 'Link a CricAPI match ID first' });

    // Rebuild name lookup before starting
    await buildLookupMap();

    livePoller.startPolling(String(match._id), match.cricApiMatchId);
    match.pollingEnabled = true;
    await match.save();

    res.json({ message: 'Live polling started', matchId: match._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/cricapi/poll/:matchId/stop — stop live polling
const stopPoll = async (req, res) => {
  try {
    livePoller.stopPolling(req.params.matchId);
    await Match.findByIdAndUpdate(req.params.matchId, { pollingEnabled: false });
    res.json({ message: 'Polling stopped' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/cricapi/poll/status — active pollers + rate usage
const getPollingStatus = async (req, res) => {
  try {
    const pollers = livePoller.getStatus();
    const apiCallsToday = await getUsageToday();
    res.json({ activePollers: pollers, apiCallsToday, dailyLimit: 100 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/cricapi/sync-once/:matchId — one-time scorecard sync
const syncOnce = async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (!match.cricApiMatchId) return res.status(400).json({ message: 'Link a CricAPI match ID first' });

    await buildLookupMap();
    await livePoller.pollOnce(String(match._id), match.cricApiMatchId);
    res.json({ message: 'Sync completed' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/cricapi/preview/:matchId — fetch + map WITHOUT saving
const previewScorecard = async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (!match.cricApiMatchId) return res.status(400).json({ message: 'Link a CricAPI match ID first' });

    await buildLookupMap();
    const raw = await getMatchScorecard(match.cricApiMatchId);
    const { performances, matchEnded, images } = mapScorecardToPerformances(raw);

    // Resolve names without saving
    const preview = [];
    for (const perf of performances) {
      const result = await matchPlayer(perf.cricApiName);
      preview.push({
        cricApiName: perf.cricApiName,
        matched: result ? { playerId: result.playerId, playerName: result.playerName, confidence: result.confidence } : null,
        stats: perf,
        imageUrl: images[perf.cricApiName] || null,
      });
    }

    res.json({ matchEnded, playerCount: performances.length, preview });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/cricapi/sync-images — pull player images from CricAPI data
const syncImages = async (req, res) => {
  try {
    // Find all live/completed matches with CricAPI IDs and sync images
    const matches = await Match.find({ cricApiMatchId: { $ne: '' } });
    let updated = 0;

    await buildLookupMap();

    for (const match of matches) {
      try {
        const raw = await getMatchScorecard(match.cricApiMatchId);
        const { images } = mapScorecardToPerformances(raw);

        for (const [cricApiName, imgUrl] of Object.entries(images)) {
          const result = await matchPlayer(cricApiName);
          if (result && imgUrl) {
            const player = await Player.findById(result.playerId);
            if (player && !player.imageUrl) {
              player.imageUrl = imgUrl;
              await player.save();
              updated++;
            }
          }
        }
      } catch {
        // Skip matches that fail (rate limit, etc)
        continue;
      }
    }

    res.json({ message: `Updated ${updated} player images` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/cricapi/auto-link — auto-match CricAPI matches to local matches by team+date
const autoLink = async (req, res) => {
  try {
    const result = await autoLinkMatches();
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { linkMatch, startPoll, stopPoll, getPollingStatus, syncOnce, previewScorecard, syncImages, autoLink };
