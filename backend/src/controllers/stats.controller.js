const FantasyTeam = require('../models/FantasyTeam.model');
const PlayerPerformance = require('../models/PlayerPerformance.model');
const Match = require('../models/Match.model');
const Prediction = require('../models/Prediction.model');
const { getActiveLeagueMemberIds } = require('../services/league-members.service');

// GET /api/stats/season-insights
// Returns leaderboard variations: best captain, most consistent, biggest gainer, best predictor
const getSeasonInsights = async (req, res) => {
  try {
    const completedMatches = await Match.find({ status: 'completed' }).select('_id team1 team2 result');
    const matchIds = completedMatches.map(m => m._id);
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

    // --- Real Money: ₹60/match, top-5 payout (150/125/100/75/50), rest → award pool ---
    const ENTRY_FEE = 60;
    const PRIZE_TABLE = [150, 125, 100, 75, 50]; // 1st through 5th
    const moneyByUser = {};
    let totalAwardPool = 0;

    for (const matchId of matchIds) {
      const matchTeams = allTeams.filter(t => String(t.matchId) === String(matchId));
      if (matchTeams.length === 0) continue;

      const pot = matchTeams.length * ENTRY_FEE;
      const prizeSum = PRIZE_TABLE.reduce((a, b) => a + b, 0);
      totalAwardPool += Math.max(0, pot - prizeSum);

      // Rank teams by totalPoints
      const ranked = [...matchTeams].sort((a, b) => b.totalPoints - a.totalPoints);

      // Handle ties: group by points, split combined prizes
      const prizeByUid = {};
      let prizeIdx = 0;
      let i = 0;
      while (i < ranked.length) {
        // Find tie group
        let j = i;
        while (j < ranked.length && ranked[j].totalPoints === ranked[i].totalPoints) j++;
        const tieCount = j - i;

        // Sum prizes for positions in this tie group
        let tieTotal = 0;
        for (let k = prizeIdx; k < Math.min(prizeIdx + tieCount, PRIZE_TABLE.length); k++) {
          tieTotal += PRIZE_TABLE[k];
        }
        const shareEach = tieCount > 0 ? tieTotal / tieCount : 0;

        for (let k = i; k < j; k++) {
          const uid = String(ranked[k].userId._id);
          prizeByUid[uid] = shareEach;
        }

        prizeIdx += tieCount;
        i = j;
      }

      for (const t of matchTeams) {
        const uid = String(t.userId._id);
        if (!moneyByUser[uid]) moneyByUser[uid] = { name: t.userId.name, invested: 0, won: 0 };
        moneyByUser[uid].invested += ENTRY_FEE;
        moneyByUser[uid].won += prizeByUid[uid] || 0;
      }
    }

    const money = Object.entries(moneyByUser)
      .map(([id, d]) => ({
        userId: id,
        userName: d.name,
        invested: d.invested,
        won: Math.round(d.won),
        net: Math.round(d.won - d.invested),
      }))
      .sort((a, b) => b.net - a.net);

    const insights = [
      bestCaptain && { type: 'best_captain', icon: 'stars', ...bestCaptain },
      mostConsistent && { type: 'most_consistent', icon: 'trending_flat', ...mostConsistent },
      biggestGainer && { type: 'biggest_gainer', icon: 'trending_up', ...biggestGainer },
      bestPredictor && { type: 'best_predictor', icon: 'psychology', ...bestPredictor },
    ].filter(Boolean);

    res.json({ insights, money, entryFee: ENTRY_FEE, awardPool: totalAwardPool });
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

    const allTeams = (await FantasyTeam.find({ matchId: { $in: matchIds }, userId: { $in: activeMemberIds } })
      .populate('userId', 'name')
      .populate('captain', 'name role')
      .populate('viceCaptain', 'name role')
      .populate('players', 'name role'))
      .filter((team) => team.userId != null);

    const allPerfs = await PlayerPerformance.find({ matchId: { $in: matchIds } })
      .populate('playerId', 'name role');

    const predictions = (await Prediction.find({ matchId: { $in: matchIds }, userId: { $in: activeMemberIds } })
      .populate('userId', 'name'))
      .filter((prediction) => prediction.userId != null);

    // Build lookup: matchId+playerId → fantasyPoints
    const perfMap = {};
    for (const p of allPerfs) {
      const key = `${p.matchId}_${p.playerId._id}`;
      perfMap[key] = p;
    }

    // Build per-user match data
    const userMatchData = {}; // userId → [{ matchId, totalPoints, rank, capPts, vcPts, batPts, bowlPts, arPts }]

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

        // Calculate captain and VC points
        const capId = typeof t.captain === 'object' ? t.captain._id : t.captain;
        const vcId = typeof t.viceCaptain === 'object' ? t.viceCaptain._id : t.viceCaptain;
        const capPerf = perfMap[`${mid}_${capId}`];
        const vcPerf = perfMap[`${mid}_${vcId}`];
        const capPts = capPerf ? capPerf.fantasyPoints * 2 : 0;
        const vcPts = vcPerf ? vcPerf.fantasyPoints * 1.5 : 0;

        // Calculate points by player role
        let batPts = 0, bowlPts = 0, arPts = 0;
        for (const p of (t.players || [])) {
          const player = typeof p === 'object' ? p : null;
          if (!player) continue;
          const pPerf = perfMap[`${mid}_${player._id}`];
          const pts = pPerf ? pPerf.fantasyPoints : 0;
          const role = player.role;
          if (role === 'BAT') batPts += pts;
          else if (role === 'BOWL') bowlPts += pts;
          else if (role === 'AR' || role === 'WK') arPts += pts;
        }

        // Rank (handle ties: same totalPoints = same rank)
        let rank = 1;
        for (let j = 0; j < i; j++) {
          if (matchTeams[j].totalPoints > t.totalPoints) rank = j + 2;
        }
        if (i > 0 && matchTeams[i - 1].totalPoints === t.totalPoints) {
          // Same rank as previous
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

    // 1. Max Score in a Single Match
    let bestSingle = { name: '', pts: 0 };
    for (const [, u] of users) {
      for (const m of u.matches) {
        if (m.totalPoints > bestSingle.pts) bestSingle = { name: u.name, pts: m.totalPoints };
      }
    }
    awards.push({ type: 'max_single_match', icon: 'bolt', title: 'Max Score (Single Match)', winner: bestSingle.name, value: `${bestSingle.pts} pts` });

    // 2. Highest Score All Time (Sum)
    const totalByUser = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.totalPoints, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (totalByUser[0]) awards.push({ type: 'highest_total', icon: 'trending_up', title: 'Highest Total Score', winner: totalByUser[0].name, value: `${totalByUser[0].total} pts` });

    // 3. Lowest Score All Time (Sum)
    const lowestTotal = [...totalByUser].sort((a, b) => a.total - b.total);
    if (lowestTotal[0]) awards.push({ type: 'lowest_total', icon: 'trending_down', title: 'Lowest Total Score', winner: lowestTotal[0].name, value: `${lowestTotal[0].total} pts` });

    // 4. Highest Captain Score (Sum)
    const capTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.capPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (capTotals[0]) awards.push({ type: 'best_captain_total', icon: 'stars', title: 'Best Captain Picker', winner: capTotals[0].name, value: `${capTotals[0].total} captain pts` });

    // 5. Highest Vice-Captain Score (Sum)
    const vcTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.vcPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (vcTotals[0]) awards.push({ type: 'best_vc_total', icon: 'star_half', title: 'Best Vice-Captain Picker', winner: vcTotals[0].name, value: `${vcTotals[0].total} VC pts` });

    // 6. Pity Award (Maximum 7th position finishes)
    const seventhCounts = users.map(([, u]) => ({
      name: u.name, count: u.matches.filter(m => m.rank === 7).length,
    })).sort((a, b) => b.count - a.count);
    if (seventhCounts[0] && seventhCounts[0].count > 0) awards.push({ type: 'pity_award', icon: 'sentiment_dissatisfied', title: 'Pity Award (Most 7th Places)', winner: seventhCounts[0].name, value: `${seventhCounts[0].count} times 7th` });

    // 7. Position Lover (Maximum times at same position)
    let posLover = { name: '', pos: 0, count: 0 };
    for (const [, u] of users) {
      const posCounts = {};
      for (const m of u.matches) {
        posCounts[m.rank] = (posCounts[m.rank] || 0) + 1;
      }
      for (const [pos, cnt] of Object.entries(posCounts)) {
        if (cnt > posLover.count) posLover = { name: u.name, pos: Number(pos), count: cnt };
      }
    }
    if (posLover.count > 0) awards.push({ type: 'position_lover', icon: 'repeat', title: 'Position Lover', winner: posLover.name, value: `${posLover.count}× at #${posLover.pos}` });

    // 8. Jack of All (Max number of distinct positions held)
    const jackOfAll = users.map(([, u]) => ({
      name: u.name, positions: new Set(u.matches.map(m => m.rank)).size,
    })).sort((a, b) => b.positions - a.positions);
    if (jackOfAll[0]) awards.push({ type: 'jack_of_all', icon: 'shuffle', title: 'Jack of All Trades', winner: jackOfAll[0].name, value: `${jackOfAll[0].positions} different positions` });

    // 9. The Batsman (Highest points from BAT role)
    const batTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.batPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (batTotals[0]) awards.push({ type: 'the_batsman', icon: 'sports_cricket', title: 'The Batsman', winner: batTotals[0].name, value: `${batTotals[0].total} pts from batters` });

    // 10. The Bowler (Highest points from BOWL role)
    const bowlTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.bowlPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (bowlTotals[0]) awards.push({ type: 'the_bowler', icon: 'sports_baseball', title: 'The Bowler', winner: bowlTotals[0].name, value: `${bowlTotals[0].total} pts from bowlers` });

    // 11. All-Rounder (Highest points from AR + WK)
    const arTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.arPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (arTotals[0]) awards.push({ type: 'all_rounder', icon: 'psychology', title: 'All-Rounder Guru', winner: arTotals[0].name, value: `${arTotals[0].total} pts from AR/WK` });

    // 12. Best Predictor (Win prediction accuracy)
    const predByUser = {};
    for (const p of predictions) {
      const uid = String(p.userId._id);
      if (!predByUser[uid]) predByUser[uid] = { name: p.userId.name, correct: 0, total: 0 };
      predByUser[uid].total++;
      if (p.isCorrect) predByUser[uid].correct++;
    }
    const predictors = Object.values(predByUser)
      .map(u => ({ name: u.name, pct: u.total > 0 ? Math.round((u.correct / u.total) * 100) : 0, correct: u.correct, total: u.total }))
      .sort((a, b) => b.pct - a.pct || b.correct - a.correct);
    if (predictors[0] && predictors[0].total > 0) awards.push({ type: 'best_predictor', icon: 'psychology_alt', title: 'Best Winner Predictor', winner: predictors[0].name, value: `${predictors[0].pct}% (${predictors[0].correct}/${predictors[0].total})` });

    res.json({ awards, matchesPlayed: matchIds.length });
  } catch (err) {
    console.error('Season awards error:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getSeasonInsights, getSeasonAwards };
