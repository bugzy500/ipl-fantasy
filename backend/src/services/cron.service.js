/**
 * Cron Jobs — Live Scoring + Deadline Reminders
 *
 * Uses setInterval instead of node-cron to avoid extra dependencies.
 * Started once from app.js after MongoDB connects.
 */
const Match = require('../models/Match.model');
const Player = require('../models/Player.model');
const FantasyTeam = require('../models/FantasyTeam.model');
const PlayerPerformance = require('../models/PlayerPerformance.model');
const User = require('../models/User.model');
const League = require('../models/League.model');
const { calculateFantasyPoints, applyMultiplier } = require('./scoring.service');
const { calculateAwards } = require('./awards.service');
const { getScorecard, mapScorecardToPerformances } = require('./cricket-data.service');
const { sendDeadlineReminder, sendScoreUpdate, sendMatchSummary } = require('./whatsapp.service');

// Track which matches we've already sent reminders for
const sentReminders = new Set(); // matchId strings
// Track last score update time per match to avoid spamming WhatsApp
const lastWhatsAppUpdate = new Map(); // matchId -> timestamp

/**
 * CRON 1: Live Score Fetcher — runs every 3 minutes during live matches.
 * Fetches scorecard from CricketData.org, maps to performances,
 * recalculates fantasy points for all teams.
 */
async function liveScoreTick() {
  try {
    const liveMatches = await Match.find({ status: 'live', cricApiMatchId: { $exists: true, $ne: '' } });
    if (liveMatches.length === 0) return;

    for (const match of liveMatches) {
      try {
        // Fetch latest scorecard
        const scorecard = await getScorecard(match.cricApiMatchId);
        if (!scorecard) continue;

        // Build player name -> doc map for fuzzy matching
        const allPlayers = await Player.find({
          franchise: { $in: [match.team1, match.team2] },
        });
        const playersByName = new Map();
        for (const p of allPlayers) {
          playersByName.set(p.name.trim().toLowerCase(), p);
        }

        // Map scorecard to our performance format
        const performances = mapScorecardToPerformances(scorecard, playersByName);
        if (performances.length === 0) continue;

        // Upsert performances + calculate points
        const playerPointsMap = {};
        for (const perf of performances) {
          const player = allPlayers.find((p) => String(p._id) === perf.playerId);
          if (!player) continue;

          const fantasyPoints = calculateFantasyPoints(perf, player.role);
          await PlayerPerformance.findOneAndUpdate(
            { playerId: perf.playerId, matchId: match._id },
            { ...perf, matchId: match._id, fantasyPoints },
            { upsert: true, new: true }
          );
          playerPointsMap[perf.playerId] = fantasyPoints;
        }

        // Recalculate all fantasy teams
        const teams = await FantasyTeam.find({ matchId: match._id });
        for (const team of teams) {
          let totalPoints = 0;
          for (const playerId of team.players) {
            const basePoints = playerPointsMap[String(playerId)] ?? 0;
            const isCaptain = String(team.captain) === String(playerId);
            const isVC = String(team.viceCaptain) === String(playerId);
            totalPoints += applyMultiplier(basePoints, isCaptain, isVC);
          }
          team.totalPoints = Math.round(totalPoints * 10) / 10;
          await team.save();
        }

        // Send WhatsApp update every 15 minutes (not every poll)
        const now = Date.now();
        const lastSent = lastWhatsAppUpdate.get(String(match._id)) || 0;
        if (now - lastSent >= 15 * 60 * 1000) {
          const topTeams = teams
            .sort((a, b) => b.totalPoints - a.totalPoints)
            .slice(0, 5);
          const topUsers = [];
          for (const t of topTeams) {
            const user = await User.findById(t.userId);
            if (user) topUsers.push({ userName: user.name, totalPoints: t.totalPoints });
          }
          if (topUsers.length > 0) {
            await sendScoreUpdate(match, topUsers);
            lastWhatsAppUpdate.set(String(match._id), now);
          }
        }

        console.log(`[LiveScore] Updated ${match.team1} vs ${match.team2}: ${performances.length} players, ${teams.length} teams`);
      } catch (err) {
        console.error(`[LiveScore] Error for match ${match._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[LiveScore] Tick error:', err.message);
  }
}

/**
 * CRON 2: Deadline Reminders — runs every 10 minutes.
 * Checks upcoming matches within 2 hours of deadline.
 * Tags users in the WhatsApp group who haven't submitted teams.
 */
async function deadlineReminderTick() {
  try {
    const now = new Date();
    const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    // Find matches with deadline in the next 2 hours that aren't completed/abandoned
    const upcomingMatches = await Match.find({
      status: { $in: ['upcoming', 'toss_done'] },
      deadline: { $gte: now, $lte: twoHoursFromNow },
    });

    for (const match of upcomingMatches) {
      const matchKey = String(match._id);

      // Only send one reminder per match
      if (sentReminders.has(matchKey)) continue;

      // Get all league members
      const league = await League.findOne({}).populate('members');
      if (!league) continue;

      // Find who has already submitted a team
      const submittedTeams = await FantasyTeam.find({ matchId: match._id });
      const submittedUserIds = new Set(submittedTeams.map((t) => String(t.userId)));

      // Find users who haven't submitted and have phone numbers
      const missingUsers = [];
      for (const memberId of league.members) {
        const userId = String(memberId._id ?? memberId);
        if (!submittedUserIds.has(userId)) {
          const user = await User.findById(userId);
          if (user && user.phone) {
            missingUsers.push({ name: user.name, phone: user.phone });
          }
        }
      }

      if (missingUsers.length > 0) {
        await sendDeadlineReminder(match, missingUsers);
        sentReminders.add(matchKey);
        console.log(`[Reminder] Sent deadline reminder for ${match.team1} vs ${match.team2} — ${missingUsers.length} users tagged`);
      }
    }
  } catch (err) {
    console.error('[Reminder] Tick error:', err.message);
  }
}

/**
 * Start all cron jobs.
 */
function startCronJobs() {
  console.log('⏰ Cron jobs started');

  // Live scores: every 3 minutes
  setInterval(liveScoreTick, 3 * 60 * 1000);

  // Deadline reminders: every 10 minutes
  setInterval(deadlineReminderTick, 10 * 60 * 1000);

  // Run deadline check immediately on startup
  deadlineReminderTick();
}

module.exports = { startCronJobs, liveScoreTick, deadlineReminderTick };
