const Match = require('../models/Match.model');
const Player = require('../models/Player.model');
const { getMatchScorecard, mapScorecardToPerformances, convertResultToLocal } = require('./cricapi.service');
const { matchPlayer } = require('./name-matcher.service');
const { processPerformances } = require('./score-processor.service');
const { calculateAwards } = require('./awards.service');

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONSECUTIVE_ERRORS = 3;

// Active pollers: matchId → { intervalId, cricApiMatchId, errors }
const activePollers = new Map();

/**
 * Start live polling for a match.
 */
function startPolling(matchId, cricApiMatchId) {
  if (activePollers.has(matchId)) {
    console.log(`[Poller] Already polling match ${matchId}`);
    return;
  }

  console.log(`[Poller] Starting polling for match ${matchId} (CricAPI: ${cricApiMatchId})`);

  // Run immediately, then every 10 minutes
  pollOnce(matchId, cricApiMatchId);

  const intervalId = setInterval(() => {
    pollOnce(matchId, cricApiMatchId);
  }, POLL_INTERVAL_MS);

  activePollers.set(matchId, { intervalId, cricApiMatchId, errors: 0 });
}

/**
 * Stop polling for a match.
 */
function stopPolling(matchId) {
  const poller = activePollers.get(matchId);
  if (poller) {
    clearInterval(poller.intervalId);
    activePollers.delete(matchId);
    console.log(`[Poller] Stopped polling for match ${matchId}`);
  }
}

/**
 * Single poll tick — fetch, map, resolve names, process scores.
 */
async function pollOnce(matchId, cricApiMatchId) {
  try {
    console.log(`[Poller] Polling match ${matchId}...`);

    // 1. Fetch scorecard
    const raw = await getMatchScorecard(cricApiMatchId);

    // 2. Map to our schema shape
    const { performances, matchEnded, matchStatus, images } = mapScorecardToPerformances(raw);

    if (performances.length === 0) {
      console.log(`[Poller] No performance data yet for match ${matchId}`);
      return;
    }

    // 3. Resolve CricAPI names to local player IDs
    const match = await Match.findById(matchId);
    if (!match) { stopPolling(matchId); return; }

    const resolved = [];
    const unmatched = [];

    for (const perf of performances) {
      const result = await matchPlayer(perf.cricApiName);
      if (result) {
        resolved.push({ ...perf, playerId: result.playerId });
      } else {
        unmatched.push(perf.cricApiName);
      }
    }

    if (unmatched.length > 0) {
      console.log(`[Poller] Unmatched players: ${unmatched.join(', ')}`);
    }

    // 4. Process scores (does NOT mark completed — just updates points live)
    if (resolved.length > 0) {
      await processPerformances(matchId, resolved, { markCompleted: false });
    }

    // 5. Update player images opportunistically
    for (const [cricApiName, imgUrl] of Object.entries(images)) {
      const matched = await matchPlayer(cricApiName);
      if (matched && imgUrl) {
        await Player.findByIdAndUpdate(matched.playerId, { imageUrl: imgUrl });
      }
    }

    // 6. Update lastPolledAt
    match.lastPolledAt = new Date();
    await match.save();

    // Reset error counter on success
    const poller = activePollers.get(matchId);
    if (poller) poller.errors = 0;

    // 7. If match ended, finalize
    if (matchEnded) {
      console.log(`[Poller] Match ${matchId} ended — finalizing scores`);

      // Set match result from CricAPI status before finalizing so prediction evaluation works
      if (matchStatus && !match.result) {
        match.result = convertResultToLocal(matchStatus);
        await match.save();
      }

      // Re-process with markCompleted to lock teams + calculate awards
      await processPerformances(matchId, resolved, { markCompleted: true });
      stopPolling(matchId);

      // Update polling flag
      await Match.findByIdAndUpdate(matchId, { pollingEnabled: false });
    }

    console.log(`[Poller] Match ${matchId}: ${resolved.length} players updated, ${unmatched.length} unmatched`);
  } catch (err) {
    console.error(`[Poller] Error polling match ${matchId}:`, err.message);

    const poller = activePollers.get(matchId);
    if (poller) {
      poller.errors++;
      if (poller.errors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`[Poller] ${MAX_CONSECUTIVE_ERRORS} consecutive errors — stopping poller for match ${matchId}`);
        stopPolling(matchId);
      }
    }
  }
}

/**
 * Restart pollers for all live matches (called on server boot).
 */
async function restartActivePollers() {
  try {
    const liveMatches = await Match.find({
      status: 'live',
      pollingEnabled: true,
      cricApiMatchId: { $ne: '' },
    });

    for (const m of liveMatches) {
      startPolling(String(m._id), m.cricApiMatchId);
    }

    if (liveMatches.length > 0) {
      console.log(`[Poller] Restarted polling for ${liveMatches.length} live match(es)`);
    }
  } catch (err) {
    console.error('[Poller] Failed to restart active pollers:', err.message);
  }
}

/**
 * Get status of all active pollers + API usage.
 */
function getStatus() {
  const pollers = [];
  for (const [matchId, info] of activePollers) {
    pollers.push({ matchId, cricApiMatchId: info.cricApiMatchId, errors: info.errors });
  }
  return pollers;
}

module.exports = { startPolling, stopPolling, pollOnce, restartActivePollers, getStatus };
