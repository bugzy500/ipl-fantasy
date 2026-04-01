#!/usr/bin/env node
/**
 * Seed script — Creates users + league with all friends' phone numbers.
 * Run once: node scripts/seed-users.js
 *
 * Idempotent: skips existing users (matched by email), updates phone if missing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../src/models/User.model');
const League = require('../src/models/League.model');

const FRIENDS = [
  { name: 'Meet Deshani', email: 'meet@ipl.local', phone: '917567838028', password: 'ipl2026!', role: 'admin' },
  { name: 'Arpit Garg', email: 'arpit@ipl.local', phone: '918058905582', password: 'ipl2026!' },
  { name: 'Arvind Verma', email: 'arvind@ipl.local', phone: '919509452644', password: 'ipl2026!' },
  { name: 'AVD', email: 'avd@ipl.local', phone: '917976875390', password: 'ipl2026!' },
  { name: 'Kaushal Nanagalia', email: 'kaushal@ipl.local', phone: '917073185818', password: 'ipl2026!' },
  { name: 'Navneet Singh', email: 'navneet@ipl.local', phone: '918239215022', password: 'ipl2026!' },
  { name: 'Rahul Sharma', email: 'rahul@ipl.local', phone: '919694588842', password: 'ipl2026!' },
  { name: 'Shubham Sharma', email: 'shubham@ipl.local', phone: '918384894616', password: 'ipl2026!' },
  { name: 'Nishant', email: 'nishant@ipl.local', phone: '918200994835', password: 'ipl2026!' },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB');

  const userIds = [];

  for (const f of FRIENDS) {
    let user = await User.findOne({ email: f.email });
    if (user) {
      // Update phone if missing
      if (!user.phone && f.phone) {
        user.phone = f.phone;
        await user.save();
        console.log(`  Updated phone for ${f.name}`);
      } else {
        console.log(`  Exists: ${f.name} (${f.email})`);
      }
    } else {
      user = await User.create({
        name: f.name,
        email: f.email,
        phone: f.phone,
        password: f.password,
        role: f.role || 'user',
      });
      console.log(`  Created: ${f.name} (${f.email})`);
    }
    userIds.push(user._id);
  }

  // Create or update league
  let league = await League.findOne({ season: 'IPL_2026' });
  if (league) {
    league.members = userIds;
    await league.save();
    console.log(`\nUpdated league "${league.name}" — ${userIds.length} members, code: ${league.inviteCode}`);
  } else {
    league = await League.create({
      name: 'Bugzy 500 IPL 2026',
      adminId: userIds[0], // Meet
      members: userIds,
      season: 'IPL_2026',
    });
    console.log(`\nCreated league "${league.name}" — ${userIds.length} members, code: ${league.inviteCode}`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
