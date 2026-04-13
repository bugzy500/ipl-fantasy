#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const Player = require('../src/models/Player.model');
const Match = require('../src/models/Match.model');
const Prediction = require('../src/models/Prediction.model');
const PlayerPerformance = require('../src/models/PlayerPerformance.model');
const FantasyTeam = require('../src/models/FantasyTeam.model');
const { calculateFantasyPoints, applyMultiplier, buildFantasyPointsBreakdown } = require('../src/services/scoring.service');

const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');
const matchIdArg = process.argv.find((arg) => arg.startsWith('--match='));
const targetMatchId = matchIdArg ? matchIdArg.split('=')[1] : null;

function roundPoints(value) {
  return Math.round(value * 10) / 10;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const perfQuery = targetMatchId ? { matchId: targetMatchId } : {};
  const teamQuery = targetMatchId ? { matchId: targetMatchId } : {};
  const matchQuery = targetMatchId ? { _id: targetMatchId } : {};
  const predictionQuery = targetMatchId ? { matchId: targetMatchId } : {};

  const [performances, teams, matches, predictions] = await Promise.all([
    PlayerPerformance.find(perfQuery).lean(),
    FantasyTeam.find(teamQuery).lean(),
    Match.find(matchQuery).select('team1 team2 status').lean(),
    Prediction.find(predictionQuery).select('userId matchId bonusPoints').lean(),
  ]);

  const playerIds = [...new Set(performances.map((perf) => String(perf.playerId)))];
  const players = await Player.find({ _id: { $in: playerIds } }).select('name role').lean();
  const playersById = new Map(players.map((player) => [String(player._id), player]));
  const matchesById = new Map(matches.map((match) => [String(match._id), match]));

  const predictionBonusByMatchUser = new Map();
  for (const prediction of predictions) {
    const key = `${prediction.matchId}:${prediction.userId}`;
    predictionBonusByMatchUser.set(key, (predictionBonusByMatchUser.get(key) ?? 0) + (prediction.bonusPoints ?? 0));
  }

  const perfUpdates = [];
  const recomputedPointsByMatchPlayer = new Map();
  const perfSamples = [];

  for (const perf of performances) {
    const player = playersById.get(String(perf.playerId));
    if (!player) continue;

    const breakdown = buildFantasyPointsBreakdown(perf, player.role);
    const recomputed = breakdown.total;
    recomputedPointsByMatchPlayer.set(`${perf.matchId}:${perf.playerId}`, recomputed);

    const needsUpdate = recomputed !== perf.fantasyPoints || !perf.scoreBreakdown;
    if (needsUpdate) {
      perfUpdates.push({
        updateOne: {
          filter: { _id: perf._id },
          update: { $set: { fantasyPoints: recomputed, scoreBreakdown: breakdown } },
        },
      });

      if (perfSamples.length < 10) {
        perfSamples.push({
          player: player.name,
          role: player.role,
          matchId: String(perf.matchId),
          stored: perf.fantasyPoints,
          recomputed,
          breakdownUpdated: !perf.scoreBreakdown,
        });
      }
    }
  }

  const teamUpdates = [];
  const teamSamples = [];

  for (const team of teams) {
    let recomputedTeamTotal = 0;

    for (const playerId of team.players) {
      const basePoints = recomputedPointsByMatchPlayer.get(`${team.matchId}:${playerId}`) ?? 0;
      recomputedTeamTotal += applyMultiplier(
        basePoints,
        String(team.captain) === String(playerId),
        String(team.viceCaptain) === String(playerId)
      );
    }

    const match = matchesById.get(String(team.matchId));
    if (match?.status === 'completed') {
      recomputedTeamTotal += predictionBonusByMatchUser.get(`${team.matchId}:${team.userId}`) ?? 0;
    }

    recomputedTeamTotal = roundPoints(recomputedTeamTotal);

    if (recomputedTeamTotal !== team.totalPoints) {
      teamUpdates.push({
        updateOne: {
          filter: { _id: team._id },
          update: { $set: { totalPoints: recomputedTeamTotal } },
        },
      });

      if (teamSamples.length < 10) {
        teamSamples.push({
          teamId: String(team._id),
          match: match ? `${match.team1} vs ${match.team2}` : String(team.matchId),
          status: match?.status ?? 'unknown',
          stored: team.totalPoints,
          recomputed: recomputedTeamTotal,
          userId: String(team.userId),
        });
      }
    }
  }

  const summary = {
    mode: shouldApply ? 'apply' : 'dry-run',
    targetMatchId,
    performancesScanned: performances.length,
    performanceMismatches: perfUpdates.length,
    teamTotalsScanned: teams.length,
    teamMismatches: teamUpdates.length,
    performanceSamples: perfSamples,
    teamSamples,
  };

  if (!shouldApply) {
    console.log(JSON.stringify(summary, null, 2));
    await mongoose.disconnect();
    return;
  }

  if (perfUpdates.length > 0) {
    await PlayerPerformance.bulkWrite(perfUpdates);
  }
  if (teamUpdates.length > 0) {
    await FantasyTeam.bulkWrite(teamUpdates);
  }

  summary.updatedPerformances = perfUpdates.length;
  summary.updatedTeams = teamUpdates.length;

  console.log(JSON.stringify(summary, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
