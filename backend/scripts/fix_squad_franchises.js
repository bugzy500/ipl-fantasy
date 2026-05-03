#!/usr/bin/env node
/**
 * Fix wrong franchise assignments in the live Player collection.
 *
 * Audit found 3 issues in seed.js (now fixed in seed):
 *   1. "Mohammad Shami"  — was seeded under KKR; belongs to LSG
 *   2. "Mitchell Marsh"  — was seeded under KKR; belongs to LSG
 *   3. "Ben Duckett"     — was missing entirely; belongs to DC (added to seed)
 *
 * This script:
 *   - Moves Shami and Marsh franchise from KKR → LSG in the live DB
 *   - Inserts Ben Duckett under DC if not already present
 *
 * Usage:
 *   node scripts/fix_squad_franchises.js --dry-run   # preview (default)
 *   node scripts/fix_squad_franchises.js --apply     # write to DB
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Player = require('../src/models/Player.model');

const args = new Set(process.argv.slice(2));
const shouldApply = args.has('--apply');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\nMode: ${shouldApply ? 'APPLY' : 'DRY-RUN'}\n`);

  // ── Fix 1 & 2: Shami + Marsh franchise KKR → LSG ─────────────────────
  const wrongFranchise = await Player.find({
    name: { $in: ['Mohammad Shami', 'Mitchell Marsh'] },
    franchise: 'KKR',
  }).lean();

  if (wrongFranchise.length === 0) {
    console.log('✅ Shami / Marsh: no KKR entries found (already fixed or never seeded wrong)');
  } else {
    wrongFranchise.forEach(p =>
      console.log(`  ❌ Found: "${p.name}" franchise=KKR  →  will move to LSG`)
    );
    if (shouldApply) {
      const res = await Player.updateMany(
        { name: { $in: ['Mohammad Shami', 'Mitchell Marsh'] }, franchise: 'KKR' },
        { $set: { franchise: 'LSG' } }
      );
      console.log(`  ✅ Updated ${res.modifiedCount} player(s) to LSG\n`);
    } else {
      console.log(`  (dry-run: ${wrongFranchise.length} would be moved to LSG)\n`);
    }
  }

  // ── Fix 3: Insert Ben Duckett if missing ─────────────────────────────
  const duckett = await Player.findOne({ name: 'Ben Duckett' }).lean();
  if (duckett) {
    console.log(`✅ Ben Duckett: already in DB (franchise=${duckett.franchise})`);
    if (duckett.franchise !== 'DC') {
      console.log(`  ⚠️  Franchise is ${duckett.franchise}, expected DC — fix manually`);
    }
  } else {
    console.log('  ➕ Ben Duckett: missing from DB  →  will insert under DC');
    if (shouldApply) {
      await Player.create({
        name: 'Ben Duckett',
        franchise: 'DC',
        role: 'BAT',
        credits: 7.5,
        isActive: true,
      });
      console.log('  ✅ Inserted Ben Duckett (DC / BAT / 7.5 credits)\n');
    } else {
      console.log('  (dry-run: would insert Ben Duckett — DC / BAT / 7.5 credits)\n');
    }
  }

  // ── Summary: show current KKR / LSG counts ────────────────────────────
  const [kkrCount, lsgCount, dcCount] = await Promise.all([
    Player.countDocuments({ franchise: 'KKR' }),
    Player.countDocuments({ franchise: 'LSG' }),
    Player.countDocuments({ franchise: 'DC' }),
  ]);
  console.log('Current DB counts (after script):');
  console.log(`  KKR: ${kkrCount} players`);
  console.log(`  LSG: ${lsgCount} players`);
  console.log(`  DC:  ${dcCount} players`);

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
