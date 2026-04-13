#!/usr/bin/env node

/**
 * Fix stale prediction bonusPoints in the database.
 *
 * Background: prediction bonus was increased from 25→50 (winner) and 80→150
 * (superover) in commit ac3bcde on 2026-04-11. Any match finalised before
 * the backend was redeployed still has the old values baked into the
 * Prediction documents AND the FantasyTeam.totalPoints.
 *
 * This script:
 * 1. Finds all Predictions with bonusPoints=25 (old winner) or 80 (old superover)
 *    where isCorrect=true.
 * 2. Updates them to 50 / 150 respectively.
 * 3. Recalculates FantasyTeam.totalPoints for affected matches by re-running
 *    the same aggregation the score-processor uses.
 *
 * Usage:
 *   node scripts/fix_prediction_bonus.js --dry-run   # preview
 *   node scripts/fix_prediction_bonus.js --apply      # fix
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Prediction = require('../src/models/Prediction.model');
const FantasyTeam = require('../src/models/FantasyTeam.model');
const Match = require('../src/models/Match.model');

const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');

const CORRECT_WINNER = 50;
const CORRECT_SUPEROVER = 150;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // Find stale correct predictions (bonusPoints = 25 means old winner rate)
  const stalePredictions = await Prediction.find({
    isCorrect: true,
    $or: [
      { bonusPoints: 25 },  // old winner rate (should be 50)
      { bonusPoints: 80 },  // old superover rate (should be 150)
    ],
  }).lean();

  console.log(`\nMode: ${shouldApply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Found ${stalePredictions.length} stale prediction(s)\n`);

  if (stalePredictions.length === 0) {
    console.log('Nothing to fix.');
    await mongoose.disconnect();
    return;
  }

  const affectedMatchIds = new Set();
  const predictionUpdates = [];

  for (const pred of stalePredictions) {
    const oldBonus = pred.bonusPoints;
    const newBonus = oldBonus === 25 ? CORRECT_WINNER : CORRECT_SUPEROVER;
    const diff = newBonus - oldBonus;

    console.log(
      `  Prediction ${pred._id}: user=${pred.userId}, match=${pred.matchId}, ` +
      `type=${pred.predictionType}, old=${oldBonus} → new=${newBonus} (+${diff})`
    );

    affectedMatchIds.add(String(pred.matchId));

    predictionUpdates.push({
      updateOne: {
        filter: { _id: pred._id },
        update: { $set: { bonusPoints: newBonus } },
      },
    });
  }

  // Now recalculate team totals for affected matches
  const teamUpdates = [];

  for (const matchId of affectedMatchIds) {
    const match = await Match.findById(matchId).select('team1 team2 status').lean();
    if (!match || match.status !== 'completed') continue;

    // Get all predictions for this match (with corrected values)
    const matchPreds = stalePredictions.filter(p => String(p.matchId) === matchId);

    // Build a map of userId → bonus diff
    const bonusDiffByUser = {};
    for (const pred of matchPreds) {
      const uid = String(pred.userId);
      const oldBonus = pred.bonusPoints;
      const newBonus = oldBonus === 25 ? CORRECT_WINNER : CORRECT_SUPEROVER;
      bonusDiffByUser[uid] = (bonusDiffByUser[uid] || 0) + (newBonus - oldBonus);
    }

    // Find teams for affected users in this match
    const userIds = Object.keys(bonusDiffByUser);
    const teams = await FantasyTeam.find({
      matchId,
      userId: { $in: userIds },
    }).lean();

    for (const team of teams) {
      const uid = String(team.userId);
      const diff = bonusDiffByUser[uid] || 0;
      if (diff === 0) continue;

      const oldTotal = team.totalPoints;
      const newTotal = Math.round((oldTotal + diff) * 10) / 10;

      console.log(
        `  Team ${team._id}: match=${match.team1} vs ${match.team2}, ` +
        `user=${uid}, totalPoints ${oldTotal} → ${newTotal} (+${diff})`
      );

      teamUpdates.push({
        updateOne: {
          filter: { _id: team._id },
          update: { $set: { totalPoints: newTotal } },
        },
      });
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Predictions to fix: ${predictionUpdates.length}`);
  console.log(`  Team totals to fix: ${teamUpdates.length}`);
  console.log(`  Affected matches: ${affectedMatchIds.size}`);

  if (!shouldApply) {
    console.log('\nRun with --apply to commit changes.');
    await mongoose.disconnect();
    return;
  }

  if (predictionUpdates.length > 0) {
    await Prediction.bulkWrite(predictionUpdates);
    console.log(`\n✓ Updated ${predictionUpdates.length} prediction(s)`);
  }
  if (teamUpdates.length > 0) {
    await FantasyTeam.bulkWrite(teamUpdates);
    console.log(`✓ Updated ${teamUpdates.length} team total(s)`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
