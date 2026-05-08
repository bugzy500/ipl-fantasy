const FantasyTeam = require('../models/FantasyTeam.model');
const PlayerPerformance = require('../models/PlayerPerformance.model');
const Match = require('../models/Match.model');
const Prediction = require('../models/Prediction.model');
const { getActiveLeagueMemberIds } = require('../services/league-members.service');

// ── Prize structure split: 2026-04-29 (last old match) vs 2026-04-30 (new rules) ──
// Old: 9 original players × ₹60. New: 13 originals × ₹60 + 4 new × ₹50.
const NEW_RULES_CUTOFF = new Date('2026-04-30T00:00:00.000Z');

// 4 members added 2026-04-30 at ₹50/match, excluded from season awards
const NEW_MEMBER_IDS = new Set([
  '69f339fb344710fa2f7f847c', // Akash
  '69f33a01344710fa2f7f8487', // Cheeku (Juhi)
  '69f33af6344710fa2f7f8560', // Prachi
  '69cd2b4a1b45394ca935d602', // DSP (Arvind)
]);

// Prize tables
const OLD_PRIZE_TABLE  = [150, 130, 110, 90, 70, 50, 40];        // pre-Apr 30, 7 positions
const NEW_PRIZE_TABLE  = [160, 140, 120, 100, 85, 75, 65, 55, 50]; // from Apr 30, 9 positions
const ENTRY_FEE_OLD    = 60;
const ENTRY_FEE_NEW    = 60; // original members still pay ₹60
const ENTRY_FEE_NEWMEM = 50; // new members pay ₹50

function getPrizeTable(matchDate) {
  return matchDate >= NEW_RULES_CUTOFF ? NEW_PRIZE_TABLE : OLD_PRIZE_TABLE;
}
function getEntryFee(userId, matchDate) {
  if (matchDate < NEW_RULES_CUTOFF) return ENTRY_FEE_OLD;
  return NEW_MEMBER_IDS.has(String(userId)) ? ENTRY_FEE_NEWMEM : ENTRY_FEE_NEW;
}

// GET /api/stats/season-insights
// Returns leaderboard variations: best captain, most consistent, biggest gainer, best predictor
const getSeasonInsights = async (req, res) => {
  try {
    const completedMatches = await Match.find({ status: 'completed' }).select('_id team1 team2 result scheduledAt');
    const matchIds = completedMatches.map(m => m._id);
    const matchLookup = {};
    for (const m of completedMatches) { matchLookup[String(m._id)] = m; }
    const activeMemberIds = await getActiveLeagueMemberIds();

    if (matchIds.length === 0 || activeMemberIds.length === 0) return res.json({ insights: [], money: [] });

    const allTeams = (await FantasyTeam.find({ matchId: { $in: matchIds }, userId: { $in: activeMemberIds } })
      .populate('userId', 'name')
      .populate('captain', 'name'))
      .filter((team) => team.userId != null);

    const allPerfs = await PlayerPerformance.find({ matchId: { $in: matchIds } })
      .populate('playerId', 'name');

    // --- Best Captain Pick (highest avg captain points) ---
    const captainPointsByUser = {};
    for (const team of allTeams) {
      const uid = String(team.userId._id);
      const capId = String(team.captain._id || team.captain);
      const capPerf = allPerfs.find(p => String(p.playerId._id) === capId && String(p.matchId) === String(team.matchId));
      const capPts = capPerf ? capPerf.fantasyPoints * 2 : 0;
      if (!captainPointsByUser[uid]) captainPointsByUser[uid] = { name: team.userId.name, total: 0, count: 0 };
      captainPointsByUser[uid].total += capPts;
      captainPointsByUser[uid].count++;
    }
    const bestCaptain = Object.entries(captainPointsByUser)
      .map(([id, d]) => ({ userId: id, userName: d.name, value: Math.round(d.total / d.count), label: `${Math.round(d.total / d.count)} avg captain pts` }))
      .sort((a, b) => b.value - a.value)[0] || null;

    // --- Most Consistent (lowest std deviation across matches) ---
    const pointsByUser = {};
    for (const team of allTeams) {
      const uid = String(team.userId._id);
      if (!pointsByUser[uid]) pointsByUser[uid] = { name: team.userId.name, scores: [] };
      pointsByUser[uid].scores.push(team.totalPoints);
    }
    const consistentEntries = Object.entries(pointsByUser)
      .filter(([, d]) => d.scores.length >= 2)
      .map(([id, d]) => {
        const avg = d.scores.reduce((a, b) => a + b, 0) / d.scores.length;
        const variance = d.scores.reduce((a, s) => a + Math.pow(s - avg, 2), 0) / d.scores.length;
        return { userId: id, userName: d.name, value: Math.round(Math.sqrt(variance)), avg: Math.round(avg), label: `${Math.round(Math.sqrt(variance))} std dev (avg ${Math.round(avg)})` };
      })
      .sort((a, b) => a.value - b.value);
    const mostConsistent = consistentEntries[0] || null;

    // --- Biggest Gainer (highest single-match score) ---
    const biggestGainer = allTeams
      .map(t => ({ userId: String(t.userId._id), userName: t.userId.name, value: t.totalPoints, matchId: t.matchId }))
      .sort((a, b) => b.value - a.value)[0] || null;
    if (biggestGainer) {
      const m = completedMatches.find(mm => String(mm._id) === String(biggestGainer.matchId));
      biggestGainer.label = `${biggestGainer.value} pts in ${m ? m.team1 + ' vs ' + m.team2 : 'a match'}`;
    }

    // --- Best Predictor (most correct predictions) ---
    const predictions = (await Prediction.find({ matchId: { $in: matchIds }, isCorrect: true, userId: { $in: activeMemberIds } })
      .populate('userId', 'name'))
      .filter((prediction) => prediction.userId != null);
    const predCountByUser = {};
    for (const p of predictions) {
      const uid = String(p.userId._id);
      if (!predCountByUser[uid]) predCountByUser[uid] = { name: p.userId.name, count: 0 };
      predCountByUser[uid].count++;
    }
    const bestPredictor = Object.entries(predCountByUser)
      .map(([id, d]) => ({ userId: id, userName: d.name, value: d.count, label: `${d.count}/${matchIds.length} correct` }))
      .sort((a, b) => b.value - a.value)[0] || null;

    // --- Real Money: prize structure split at 2026-04-30 ---
    const moneyByUser = {};
    let totalAwardPool = 0;

    for (const matchId of matchIds) {
      const match = completedMatches.find(m => String(m._id) === String(matchId));
      const matchDate = match?.scheduledAt ?? new Date(0);

      // New members (DSP + Akash/Juhi/Prachi) only count from Apr 30 onwards
      const matchTeams = allTeams.filter(t => {
        if (String(t.matchId) !== String(matchId)) return false;
        if (matchDate < NEW_RULES_CUTOFF && NEW_MEMBER_IDS.has(String(t.userId._id))) return false;
        return true;
      });
      if (matchTeams.length === 0) continue;
      const prizeTable = getPrizeTable(matchDate);

      const pot = matchTeams.reduce((sum, t) => sum + getEntryFee(t.userId._id, matchDate), 0);
      const prizeSum = prizeTable.reduce((a, b) => a + b, 0);
      totalAwardPool += Math.max(0, pot - prizeSum);

      // Rank teams by totalPoints
      const ranked = [...matchTeams].sort((a, b) => b.totalPoints - a.totalPoints);

      // Handle ties: group by points, split combined prizes
      const prizeByUid = {};
      let prizeIdx = 0;
      let i = 0;
      while (i < ranked.length) {
        let j = i;
        while (j < ranked.length && ranked[j].totalPoints === ranked[i].totalPoints) j++;
        const tieCount = j - i;

        let tieTotal = 0;
        for (let k = prizeIdx; k < Math.min(prizeIdx + tieCount, prizeTable.length); k++) {
          tieTotal += prizeTable[k];
        }
        const shareEach = tieCount > 0 ? tieTotal / tieCount : 0;

        for (let k = i; k < j; k++) {
          prizeByUid[String(ranked[k].userId._id)] = shareEach;
        }

        prizeIdx += tieCount;
        i = j;
      }

      // Find match info for labels
      const matchDoc = matchLookup[String(matchId)];
      const matchLabel = matchDoc ? `${matchDoc.team1} vs ${matchDoc.team2}` : 'Unknown';

      for (const t of matchTeams) {
        const uid = String(t.userId._id);
        if (!moneyByUser[uid]) moneyByUser[uid] = { name: t.userId.name, invested: 0, won: 0, matches: [] };
        const won = prizeByUid[uid] || 0;
        const rank = ranked.findIndex(r => String(r.userId._id) === uid) + 1;
        const fee = getEntryFee(uid, matchDate);
        moneyByUser[uid].invested += fee;
        moneyByUser[uid].won += won;
        moneyByUser[uid].matches.push({
          matchLabel,
          matchDate,
          rank,
          points: t.totalPoints,
          won: Math.round(won),
          net: Math.round(won - fee),
        });
      }
    }

    const money = Object.entries(moneyByUser)
      .map(([id, d]) => ({
        userId: id,
        userName: d.name,
        invested: d.invested,
        won: Math.round(d.won),
        net: Math.round(d.won - d.invested),
        matches: d.matches.sort((a, b) => new Date(a.matchDate) - new Date(b.matchDate)),
      }))
      .sort((a, b) => b.net - a.net);

    const insights = [
      bestCaptain && { type: 'best_captain', icon: 'stars', ...bestCaptain },
      mostConsistent && { type: 'most_consistent', icon: 'trending_flat', ...mostConsistent },
      biggestGainer && { type: 'biggest_gainer', icon: 'trending_up', ...biggestGainer },
      bestPredictor && { type: 'best_predictor', icon: 'psychology', ...bestPredictor },
    ].filter(Boolean);

    const AWARDS_COUNT = 21;
    res.json({
      insights,
      money,
      entryFee: ENTRY_FEE_NEW,
      awardPool: Math.round(totalAwardPool),
      awardsCount: AWARDS_COUNT,
      perAward: Math.round(totalAwardPool / AWARDS_COUNT),
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ message: err.message });
  }
};

// GET /api/stats/season-awards
// Calculates all end-of-season awards from match data
const getSeasonAwards = async (req, res) => {
  try {
    const completedMatches = await Match.find({ status: 'completed' }).select('_id team1 team2 scheduledAt');
    const matchIds = completedMatches.map(m => m._id);
    const activeMemberIds = await getActiveLeagueMemberIds();

    if (matchIds.length === 0 || activeMemberIds.length === 0) return res.json({ awards: [] });

    // Season awards exclude new members (joined 2026-04-30, can't compete on full-season basis)
    const eligibleMemberIds = activeMemberIds.filter(id => !NEW_MEMBER_IDS.has(String(id)));

    const allTeams = (await FantasyTeam.find({ matchId: { $in: matchIds }, userId: { $in: eligibleMemberIds } })
      .populate('userId', 'name')
      .populate('captain', 'name role')
      .populate('viceCaptain', 'name role')
      .populate('players', 'name role'))
      .filter((team) => team.userId != null);

    const allPerfs = await PlayerPerformance.find({ matchId: { $in: matchIds } })
      .populate('playerId', 'name role');

    const predictions = (await Prediction.find({ matchId: { $in: matchIds }, userId: { $in: eligibleMemberIds } })
      .populate('userId', 'name'))
      .filter((prediction) => prediction.userId != null);

    // Build lookup: matchId+playerId → fantasyPoints
    const perfMap = {};
    for (const p of allPerfs) {
      const key = `${p.matchId}_${p.playerId._id}`;
      perfMap[key] = p;
    }

    // Build per-user match data
    const userMatchData = {}; // userId → { name, matches: [{ matchId, totalPoints, rank, ... }] }

    // First pass: group teams by match for ranking
    const teamsByMatch = {};
    for (const t of allTeams) {
      const mid = String(t.matchId);
      if (!teamsByMatch[mid]) teamsByMatch[mid] = [];
      teamsByMatch[mid].push(t);
    }

    // Rank and calculate per-user stats
    for (const [mid, matchTeams] of Object.entries(teamsByMatch)) {
      matchTeams.sort((a, b) => b.totalPoints - a.totalPoints);

      for (let i = 0; i < matchTeams.length; i++) {
        const t = matchTeams[i];
        const uid = String(t.userId._id);
        if (!userMatchData[uid]) userMatchData[uid] = { name: t.userId.name, matches: [] };

        const capId = typeof t.captain === 'object' ? t.captain._id : t.captain;
        const vcId = typeof t.viceCaptain === 'object' ? t.viceCaptain._id : t.viceCaptain;
        const capPerf = perfMap[`${mid}_${capId}`];
        const vcPerf = perfMap[`${mid}_${vcId}`];
        const capPts = capPerf ? capPerf.fantasyPoints * 2 : 0;
        const vcPts = vcPerf ? vcPerf.fantasyPoints * 1.5 : 0;

        let batPts = 0, bowlPts = 0, arPts = 0;
        for (const p of (t.players || [])) {
          const player = typeof p === 'object' ? p : null;
          if (!player) continue;
          const pPerf = perfMap[`${mid}_${player._id}`];
          const pts = pPerf ? pPerf.fantasyPoints : 0;
          const role = player.role;
          if (role === 'BAT' || role === 'WK') batPts += pts;
          else if (role === 'BOWL') bowlPts += pts;
          else if (role === 'AR') arPts += pts;
        }

        // Rank (handle ties: same totalPoints = same rank)
        let rank = 1;
        for (let j = 0; j < i; j++) {
          if (matchTeams[j].totalPoints > t.totalPoints) rank = j + 2;
        }
        if (i > 0 && matchTeams[i - 1].totalPoints === t.totalPoints) {
          rank = userMatchData[String(matchTeams[i - 1].userId._id)]?.matches.slice(-1)[0]?.rank ?? i + 1;
        }

        userMatchData[uid].matches.push({
          matchId: mid,
          totalPoints: t.totalPoints,
          rank,
          capPts: Math.round(capPts * 10) / 10,
          vcPts: Math.round(vcPts * 10) / 10,
          batPts: Math.round(batPts * 10) / 10,
          bowlPts: Math.round(bowlPts * 10) / 10,
          arPts: Math.round(arPts * 10) / 10,
        });
      }
    }

    const awards = [];
    const users = Object.entries(userMatchData);

    // Build match date lookup for date-based pity calculations
    const matchDateLookup = {};
    for (const m of completedMatches) { matchDateLookup[String(m._id)] = m.scheduledAt; }
    const cutoff5d = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    // --- Pre-compute all sorted arrays first so we can build bestWinners before pushing any award ---
    const allSingles = users.map(([, u]) => ({
      name: u.name, pts: u.matches.length ? Math.max(...u.matches.map(m => m.totalPoints)) : 0,
    })).sort((a, b) => b.pts - a.pts);

    const top3Counts = users.map(([, u]) => ({
      name: u.name, count: u.matches.filter(m => m.rank <= 3).length,
    })).sort((a, b) => b.count - a.count);

    const totalByUser = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.totalPoints, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    const lowestTotal = [...totalByUser].sort((a, b) => a.total - b.total);

    const capTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.capPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    const worstCap = [...capTotals].sort((a, b) => a.total - b.total);

    const vcTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.vcPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    const worstVc = [...vcTotals].sort((a, b) => a.total - b.total);

    // Pity 1: most 8th places in matches before 5 days ago
    const pityCounts5d = users.map(([, u]) => ({
      name: u.name, count: u.matches.filter(m => {
        const d = matchDateLookup[m.matchId];
        return m.rank === 8 && d && new Date(d) < cutoff5d;
      }).length,
    })).sort((a, b) => b.count - a.count);

    // Pity 2: biggest season rank drop in last 5 days (avg-points based)
    const avgBefore5d = {}, avgAll = {};
    for (const [uid, u] of users) {
      const beforeMatches = u.matches.filter(m => {
        const d = matchDateLookup[m.matchId];
        return d && new Date(d) < cutoff5d;
      });
      if (beforeMatches.length > 0) {
        avgBefore5d[uid] = { name: u.name, avg: beforeMatches.reduce((s, m) => s + m.totalPoints, 0) / beforeMatches.length };
      }
      if (u.matches.length > 0) {
        avgAll[uid] = { name: u.name, avg: u.matches.reduce((s, m) => s + m.totalPoints, 0) / u.matches.length };
      }
    }
    const sortedBefore = Object.entries(avgBefore5d).sort((a, b) => b[1].avg - a[1].avg);
    const rankBefore = {};
    sortedBefore.forEach(([uid], i) => { rankBefore[uid] = i + 1; });
    const sortedNow = Object.entries(avgAll).sort((a, b) => b[1].avg - a[1].avg);
    const rankNow = {};
    sortedNow.forEach(([uid], i) => { rankNow[uid] = i + 1; });
    const rankDrops = users.map(([uid, u]) => {
      const before = rankBefore[uid], now = rankNow[uid];
      const drop = (before && now) ? now - before : 0;
      return { name: u.name, drop, before: before ?? '—', now: now ?? '—' };
    }).filter(d => d.drop > 0).sort((a, b) => b.drop - a.drop);

    const allPosLovers = [];
    for (const [, u] of users) {
      const posCounts = {};
      for (const m of u.matches) posCounts[m.rank] = (posCounts[m.rank] || 0) + 1;
      let best = { pos: 0, count: 0 };
      for (const [pos, cnt] of Object.entries(posCounts)) {
        if (cnt > best.count) best = { pos: Number(pos), count: cnt };
      }
      allPosLovers.push({ name: u.name, pos: best.pos, count: best.count });
    }
    allPosLovers.sort((a, b) => b.count - a.count);

    const jackOfAll = users.map(([, u]) => ({
      name: u.name, positions: new Set(u.matches.map(m => m.rank)).size,
    })).sort((a, b) => b.positions - a.positions);

    const batTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.batPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    const batLowest = [...batTotals].sort((a, b) => a.total - b.total);

    const bowlTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.bowlPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    const bowlLowest = [...bowlTotals].sort((a, b) => a.total - b.total);

    const arTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.arPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    const arLowest = [...arTotals].sort((a, b) => a.total - b.total);

    const totalCompleted = matchIds.length;
    const predByUser = {};
    for (const p of predictions) {
      const uid = String(p.userId._id);
      if (!predByUser[uid]) predByUser[uid] = { name: p.userId.name, total: 0, correct: 0 };
      predByUser[uid].total++;
      if (p.isCorrect) predByUser[uid].correct++;
    }
    const allPredictors = Object.values(predByUser)
      .map(u => ({ name: u.name, pct: Math.round((u.correct / totalCompleted) * 100), correct: u.correct }));
    const bestPredictors = [...allPredictors].sort((a, b) => b.correct - a.correct || b.pct - a.pct);
    const worstPredictors = [...allPredictors].sort((a, b) => a.correct - b.correct || a.pct - b.pct);

    const top7Counts = users.map(([, u]) => ({
      name: u.name, count: u.matches.filter(m => m.rank <= 7).length, total: u.matches.length,
    })).sort((a, b) => a.count - b.count);

    // REQ 4: Top 2 of batsman/bowler/allrounder categories excluded from their lowest counterparts
    const bestWinners = new Set([
      allSingles[0]?.name,
      top3Counts[0]?.count > 0 ? top3Counts[0].name : null,
      totalByUser[0]?.name,
      capTotals[0]?.name,
      vcTotals[0]?.name,
      batTotals[0]?.name,
      batTotals[1]?.name,
      bowlTotals[0]?.name,
      bowlTotals[1]?.name,
      arTotals[0]?.name,
      arTotals[1]?.name,
      bestPredictors[0]?.name,
    ].filter(Boolean));

    // Helpers
    const ru = (sorted, valueFn) => sorted[1] ? { name: sorted[1].name, value: valueFn(sorted[1]) } : null;
    const th = (sorted, valueFn) => sorted[2] ? { name: sorted[2].name, value: valueFn(sorted[2]) } : null;
    const ptGap = (w, r, unit) => r ? `${Math.round((w - r) * 10) / 10} ${unit} ahead` : null;
    const cntGap = (w, r, unit) => r ? (w - r === 0 ? 'tied' : `${w - r} more ${unit}`) : null;
    // For worst awards: pick first player not in bestWinners
    const wPick = (sorted) => sorted.find(e => !bestWinners.has(e.name)) ?? null;
    const wRunner = (sorted, winner) => winner
      ? sorted.find(e => e.name !== winner.name && !bestWinners.has(e.name)) ?? null
      : null;
    const wThird = (sorted, winner, runner) => winner && runner
      ? sorted.find(e => e.name !== winner.name && e.name !== runner.name && !bestWinners.has(e.name)) ?? null
      : null;

    // 1. Max Score (Single Match)
    if (allSingles[0]) awards.push({
      type: 'max_single_match', icon: 'bolt', title: 'Max Score (Single Match)',
      winner: allSingles[0].name, value: `${allSingles[0].pts} pts`,
      runnerUp: ru(allSingles, r => `${r.pts} pts`),
      thirdPlace: th(allSingles, r => `${r.pts} pts`),
      gap: allSingles[1] ? ptGap(allSingles[0].pts, allSingles[1].pts, 'pts') : null,
    });

    // 2. Highest Top 3 Finishes
    if (top3Counts[0] && top3Counts[0].count > 0) awards.push({
      type: 'top3_finishes', icon: 'emoji_events', title: 'Highest Top 3 Finishes',
      winner: top3Counts[0].name, value: `${top3Counts[0].count} podium finishes`,
      runnerUp: ru(top3Counts, r => `${r.count} podium finishes`),
      thirdPlace: th(top3Counts, r => `${r.count} podium finishes`),
      gap: cntGap(top3Counts[0].count, top3Counts[1]?.count, 'podiums'),
    });

    // 3. Highest Total Score
    if (totalByUser[0]) awards.push({
      type: 'highest_total', icon: 'trending_up', title: 'Highest Total Score',
      winner: totalByUser[0].name, value: `${totalByUser[0].total} pts`,
      runnerUp: ru(totalByUser, r => `${r.total} pts`),
      thirdPlace: th(totalByUser, r => `${r.total} pts`),
      gap: ptGap(totalByUser[0].total, totalByUser[1]?.total, 'pts'),
    });

    // 4. Lowest Total Score — skip best-award winners
    const ltW = wPick(lowestTotal), ltR = wRunner(lowestTotal, ltW), ltT3 = wThird(lowestTotal, ltW, ltR);
    if (ltW) awards.push({
      type: 'lowest_total', icon: 'trending_down', title: 'Lowest Total Score',
      winner: ltW.name, value: `${ltW.total} pts`,
      runnerUp: ltR ? { name: ltR.name, value: `${ltR.total} pts` } : null,
      thirdPlace: ltT3 ? { name: ltT3.name, value: `${ltT3.total} pts` } : null,
      gap: ltR ? `${Math.round((ltR.total - ltW.total) * 10) / 10} pts lower` : null,
    });

    // 5. Best Captain Picker
    if (capTotals[0]) awards.push({
      type: 'best_captain', icon: 'stars', title: 'Best Captain Picker',
      winner: capTotals[0].name, value: `${capTotals[0].total} captain pts`,
      runnerUp: ru(capTotals, r => `${r.total} captain pts`),
      thirdPlace: th(capTotals, r => `${r.total} captain pts`),
      gap: ptGap(capTotals[0].total, capTotals[1]?.total, 'pts'),
    });

    // 6. Worst Captain Picker — skip best-award winners
    const wcW = wPick(worstCap), wcR = wRunner(worstCap, wcW), wcT3 = wThird(worstCap, wcW, wcR);
    if (wcW) awards.push({
      type: 'worst_captain', icon: 'star_border', title: 'Worst Captain Picker',
      winner: wcW.name, value: `${wcW.total} captain pts`,
      runnerUp: wcR ? { name: wcR.name, value: `${wcR.total} captain pts` } : null,
      thirdPlace: wcT3 ? { name: wcT3.name, value: `${wcT3.total} captain pts` } : null,
      gap: wcR ? `${Math.round((wcR.total - wcW.total) * 10) / 10} pts lower` : null,
    });

    // 7. Best Vice Captain Picker
    if (vcTotals[0]) awards.push({
      type: 'best_vc', icon: 'star_half', title: 'Best Vice Captain Picker',
      winner: vcTotals[0].name, value: `${vcTotals[0].total} VC pts`,
      runnerUp: ru(vcTotals, r => `${r.total} VC pts`),
      thirdPlace: th(vcTotals, r => `${r.total} VC pts`),
      gap: ptGap(vcTotals[0].total, vcTotals[1]?.total, 'pts'),
    });

    // 8. Worst Vice Captain Picker — skip best-award winners
    const wvcW = wPick(worstVc), wvcR = wRunner(worstVc, wvcW), wvcT3 = wThird(worstVc, wvcW, wvcR);
    if (wvcW) awards.push({
      type: 'worst_vc', icon: 'star_outline', title: 'Worst Vice Captain Picker',
      winner: wvcW.name, value: `${wvcW.total} VC pts`,
      runnerUp: wvcR ? { name: wvcR.name, value: `${wvcR.total} VC pts` } : null,
      thirdPlace: wvcT3 ? { name: wvcT3.name, value: `${wvcT3.total} VC pts` } : null,
      gap: wvcR ? `${Math.round((wvcR.total - wvcW.total) * 10) / 10} pts lower` : null,
    });

    // REQ 5a: Pity Award — Most 8th Places (matches up to 5 days ago)
    if (pityCounts5d[0] && pityCounts5d[0].count > 0) awards.push({
      type: 'pity_award', icon: 'sentiment_dissatisfied', title: 'Pity Award — Most 8th Places (till 5 days ago)',
      winner: pityCounts5d[0].name, value: `${pityCounts5d[0].count}× 8th place`,
      runnerUp: pityCounts5d[1]?.count > 0 ? { name: pityCounts5d[1].name, value: `${pityCounts5d[1].count}× 8th place` } : null,
      thirdPlace: pityCounts5d[2]?.count > 0 ? { name: pityCounts5d[2].name, value: `${pityCounts5d[2].count}× 8th place` } : null,
      gap: pityCounts5d[1]?.count > 0 ? cntGap(pityCounts5d[0].count, pityCounts5d[1].count, 'times') : null,
    });

    // REQ 5b: Pity Award — Biggest rank drop in last 5 days (avg-points based season rank)
    if (rankDrops.length > 0) awards.push({
      type: 'pity_drop', icon: 'keyboard_double_arrow_down', title: 'Pity Award — Biggest Rank Drop (last 5 days)',
      winner: rankDrops[0].name, value: `#${rankDrops[0].before} → #${rankDrops[0].now} (↓${rankDrops[0].drop})`,
      runnerUp: rankDrops[1] ? { name: rankDrops[1].name, value: `#${rankDrops[1].before} → #${rankDrops[1].now} (↓${rankDrops[1].drop})` } : null,
      thirdPlace: rankDrops[2] ? { name: rankDrops[2].name, value: `#${rankDrops[2].before} → #${rankDrops[2].now} (↓${rankDrops[2].drop})` } : null,
      gap: null,
    });

    // 10. Position Lover (Max times at same position)
    if (allPosLovers[0] && allPosLovers[0].count > 0) awards.push({
      type: 'position_lover', icon: 'repeat', title: 'Position Lover',
      winner: allPosLovers[0].name, value: `${allPosLovers[0].count}× at #${allPosLovers[0].pos}`,
      runnerUp: allPosLovers[1] ? { name: allPosLovers[1].name, value: `${allPosLovers[1].count}× at #${allPosLovers[1].pos}` } : null,
      thirdPlace: allPosLovers[2] ? { name: allPosLovers[2].name, value: `${allPosLovers[2].count}× at #${allPosLovers[2].pos}` } : null,
      gap: cntGap(allPosLovers[0].count, allPosLovers[1]?.count, 'times'),
    });

    // 11. Jack of All Trades (Most distinct positions)
    if (jackOfAll[0]) awards.push({
      type: 'jack_of_all', icon: 'shuffle', title: 'Jack of All Trades',
      winner: jackOfAll[0].name, value: `${jackOfAll[0].positions} different positions`,
      runnerUp: ru(jackOfAll, r => `${r.positions} positions`),
      thirdPlace: th(jackOfAll, r => `${r.positions} positions`),
      gap: cntGap(jackOfAll[0].positions, jackOfAll[1]?.positions, 'positions'),
    });

    // 12. The Batsman (Highest BAT + WK points)
    if (batTotals[0]) awards.push({
      type: 'the_batsman', icon: 'sports_cricket', title: 'The Batsman',
      winner: batTotals[0].name, value: `${batTotals[0].total} pts from BAT/WK`,
      runnerUp: ru(batTotals, r => `${r.total} pts`),
      thirdPlace: th(batTotals, r => `${r.total} pts`),
      gap: ptGap(batTotals[0].total, batTotals[1]?.total, 'pts'),
    });

    // 13. The Bowler (Highest BOWL points)
    if (bowlTotals[0]) awards.push({
      type: 'the_bowler', icon: 'sports_baseball', title: 'The Bowler',
      winner: bowlTotals[0].name, value: `${bowlTotals[0].total} pts from bowlers`,
      runnerUp: ru(bowlTotals, r => `${r.total} pts`),
      thirdPlace: th(bowlTotals, r => `${r.total} pts`),
      gap: ptGap(bowlTotals[0].total, bowlTotals[1]?.total, 'pts'),
    });

    // 14. The All-Rounder (Highest AR points only)
    if (arTotals[0]) awards.push({
      type: 'the_allrounder', icon: 'psychology', title: 'The All-Rounder',
      winner: arTotals[0].name, value: `${arTotals[0].total} pts from all-rounders`,
      runnerUp: ru(arTotals, r => `${r.total} pts`),
      thirdPlace: th(arTotals, r => `${r.total} pts`),
      gap: ptGap(arTotals[0].total, arTotals[1]?.total, 'pts'),
    });

    // 15. Best Win Predictor
    if (bestPredictors[0]) awards.push({
      type: 'best_predictor', icon: 'psychology_alt', title: 'Best Win Predictor',
      winner: bestPredictors[0].name, value: `${bestPredictors[0].pct}% (${bestPredictors[0].correct}/${totalCompleted})`,
      runnerUp: bestPredictors[1] ? { name: bestPredictors[1].name, value: `${bestPredictors[1].pct}% (${bestPredictors[1].correct}/${totalCompleted})` } : null,
      thirdPlace: bestPredictors[2] ? { name: bestPredictors[2].name, value: `${bestPredictors[2].pct}% (${bestPredictors[2].correct}/${totalCompleted})` } : null,
      gap: bestPredictors[1] ? `${bestPredictors[0].correct - bestPredictors[1].correct} more correct` : null,
    });

    // 16. Worst Win Predictor — skip best-award winners
    const wpW = wPick(worstPredictors), wpR = wRunner(worstPredictors, wpW), wpT3 = wThird(worstPredictors, wpW, wpR);
    if (wpW) awards.push({
      type: 'worst_predictor', icon: 'do_not_disturb', title: 'Worst Win Predictor',
      winner: wpW.name, value: `${wpW.pct}% (${wpW.correct}/${totalCompleted})`,
      runnerUp: wpR ? { name: wpR.name, value: `${wpR.pct}% (${wpR.correct}/${totalCompleted})` } : null,
      thirdPlace: wpT3 ? { name: wpT3.name, value: `${wpT3.pct}% (${wpT3.correct}/${totalCompleted})` } : null,
      gap: wpR ? `${wpR.correct - wpW.correct} fewer correct` : null,
    });

    // 17. Lowest Top 7 Finishes — skip best-award winners
    const lt7W = wPick(top7Counts), lt7R = wRunner(top7Counts, lt7W), lt7T3 = wThird(top7Counts, lt7W, lt7R);
    if (lt7W) awards.push({
      type: 'lowest_top7', icon: 'arrow_downward', title: 'Lowest Top 7 Finishes',
      winner: lt7W.name, value: `${lt7W.count}/${lt7W.total} in top 7`,
      runnerUp: lt7R ? { name: lt7R.name, value: `${lt7R.count}/${lt7R.total} in top 7` } : null,
      thirdPlace: lt7T3 ? { name: lt7T3.name, value: `${lt7T3.count}/${lt7T3.total} in top 7` } : null,
      gap: lt7R ? `${lt7R.count - lt7W.count} fewer top-7 finishes` : null,
    });

    // 18. Lowest Bowling Points — skip best-award winners
    const lbowlW = wPick(bowlLowest), lbowlR = wRunner(bowlLowest, lbowlW), lbowlT3 = wThird(bowlLowest, lbowlW, lbowlR);
    if (lbowlW) awards.push({
      type: 'lowest_bowling', icon: 'sports_baseball', title: 'Lowest Bowling Points',
      winner: lbowlW.name, value: `${lbowlW.total} pts from bowlers`,
      runnerUp: lbowlR ? { name: lbowlR.name, value: `${lbowlR.total} pts` } : null,
      thirdPlace: lbowlT3 ? { name: lbowlT3.name, value: `${lbowlT3.total} pts` } : null,
      gap: lbowlR ? `${Math.round((lbowlR.total - lbowlW.total) * 10) / 10} pts lower` : null,
    });

    // 19. Lowest Batting Points — skip best-award winners
    const lbatW = wPick(batLowest), lbatR = wRunner(batLowest, lbatW), lbatT3 = wThird(batLowest, lbatW, lbatR);
    if (lbatW) awards.push({
      type: 'lowest_batting', icon: 'sports_cricket', title: 'Lowest Batting Points',
      winner: lbatW.name, value: `${lbatW.total} pts from BAT/WK`,
      runnerUp: lbatR ? { name: lbatR.name, value: `${lbatR.total} pts` } : null,
      thirdPlace: lbatT3 ? { name: lbatT3.name, value: `${lbatT3.total} pts` } : null,
      gap: lbatR ? `${Math.round((lbatR.total - lbatW.total) * 10) / 10} pts lower` : null,
    });

    // 20. Lowest All-Rounder Points — skip best-award winners
    const larW = wPick(arLowest), larR = wRunner(arLowest, larW), larT3 = wThird(arLowest, larW, larR);
    if (larW) awards.push({
      type: 'lowest_allrounder', icon: 'psychology', title: 'Lowest All-Rounder Points',
      winner: larW.name, value: `${larW.total} pts from all-rounders`,
      runnerUp: larR ? { name: larR.name, value: `${larR.total} pts` } : null,
      thirdPlace: larT3 ? { name: larT3.name, value: `${larT3.total} pts` } : null,
      gap: larR ? `${Math.round((larR.total - larW.total) * 10) / 10} pts lower` : null,
    });

    // REQ 3: Compute award pool for tentative cash amounts shown in Season Awards tab
    const allMatchParticipants = await FantasyTeam.find({ matchId: { $in: matchIds }, userId: { $in: activeMemberIds } })
      .select('userId matchId').populate('userId', '_id').lean();
    let totalAwardPool = 0;
    for (const m of completedMatches) {
      const mid = String(m._id);
      const matchDate = m.scheduledAt;
      const mTeams = allMatchParticipants.filter(t =>
        String(t.matchId) === mid && t.userId != null &&
        !(matchDate < NEW_RULES_CUTOFF && NEW_MEMBER_IDS.has(String(t.userId._id)))
      );
      if (mTeams.length === 0) continue;
      const prizeTable = getPrizeTable(matchDate);
      const pot = mTeams.reduce((sum, t) => sum + getEntryFee(t.userId._id, matchDate), 0);
      const prizeSum = prizeTable.reduce((a, b) => a + b, 0);
      totalAwardPool += Math.max(0, pot - prizeSum);
    }
    // 1st and 2nd in each award get cash — 3rd is honorary
    const cashSlots = awards.length * 2;
    const perAward = cashSlots > 0 ? Math.round(totalAwardPool / cashSlots) : 0;

    res.json({ awards, matchesPlayed: matchIds.length, awardPool: Math.round(totalAwardPool), perAward });
  } catch (err) {
    console.error('Season awards error:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getSeasonInsights, getSeasonAwards };
