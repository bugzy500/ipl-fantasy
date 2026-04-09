const FantasyTeam = require('../models/FantasyTeam.model');
const PlayerPerformance = require('../models/PlayerPerformance.model');
const Match = require('../models/Match.model');
const Prediction = require('../models/Prediction.model');
const { getActiveLeagueMemberIds } = require('../services/league-members.service');

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

    // --- Real Money: ₹60/match, top-5 payout (150/125/100/75/50), rest → award pool ---
    const ENTRY_FEE = 60;
    const PRIZE_TABLE = [150, 130, 110, 90, 70, 50]; // 1st through 6th
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

      // Find match info for labels
      const matchDoc = matchLookup[String(matchId)];
      const matchLabel = matchDoc ? `${matchDoc.team1} vs ${matchDoc.team2}` : 'Unknown';
      const matchDate = matchDoc ? matchDoc.scheduledAt : null;

      for (const t of matchTeams) {
        const uid = String(t.userId._id);
        if (!moneyByUser[uid]) moneyByUser[uid] = { name: t.userId.name, invested: 0, won: 0, matches: [] };
        const won = prizeByUid[uid] || 0;
        const rank = ranked.findIndex(r => String(r.userId._id) === uid) + 1;
        moneyByUser[uid].invested += ENTRY_FEE;
        moneyByUser[uid].won += won;
        moneyByUser[uid].matches.push({
          matchLabel,
          matchDate,
          rank,
          points: t.totalPoints,
          won: Math.round(won),
          net: Math.round(won - ENTRY_FEE),
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

    // 1. Max Score (Single Match)
    let bestSingle = { name: '', pts: 0 };
    for (const [, u] of users) {
      for (const m of u.matches) {
        if (m.totalPoints > bestSingle.pts) bestSingle = { name: u.name, pts: m.totalPoints };
      }
    }
    awards.push({ type: 'max_single_match', icon: 'bolt', title: 'Max Score (Single Match)', winner: bestSingle.name, value: `${bestSingle.pts} pts` });

    // 2. Highest Top 3 Finishes
    const top3Counts = users.map(([, u]) => ({
      name: u.name, count: u.matches.filter(m => m.rank <= 3).length,
    })).sort((a, b) => b.count - a.count);
    if (top3Counts[0] && top3Counts[0].count > 0) awards.push({ type: 'top3_finishes', icon: 'emoji_events', title: 'Highest Top 3 Finishes', winner: top3Counts[0].name, value: `${top3Counts[0].count} podium finishes` });

    // 3. Highest Total Score
    const totalByUser = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.totalPoints, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (totalByUser[0]) awards.push({ type: 'highest_total', icon: 'trending_up', title: 'Highest Total Score', winner: totalByUser[0].name, value: `${totalByUser[0].total} pts` });

    // 4. Lowest Total Score
    const lowestTotal = [...totalByUser].sort((a, b) => a.total - b.total);
    if (lowestTotal[0]) awards.push({ type: 'lowest_total', icon: 'trending_down', title: 'Lowest Total Score', winner: lowestTotal[0].name, value: `${lowestTotal[0].total} pts` });

    // 5. Best Captain Picker
    const capTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.capPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (capTotals[0]) awards.push({ type: 'best_captain', icon: 'stars', title: 'Best Captain Picker', winner: capTotals[0].name, value: `${capTotals[0].total} captain pts` });

    // 6. Worst Captain Picker
    const worstCap = [...capTotals].sort((a, b) => a.total - b.total);
    if (worstCap[0]) awards.push({ type: 'worst_captain', icon: 'star_border', title: 'Worst Captain Picker', winner: worstCap[0].name, value: `${worstCap[0].total} captain pts` });

    // 7. Best Vice Captain Picker
    const vcTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.vcPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (vcTotals[0]) awards.push({ type: 'best_vc', icon: 'star_half', title: 'Best Vice Captain Picker', winner: vcTotals[0].name, value: `${vcTotals[0].total} VC pts` });

    // 8. Worst Vice Captain Picker
    const worstVc = [...vcTotals].sort((a, b) => a.total - b.total);
    if (worstVc[0]) awards.push({ type: 'worst_vc', icon: 'star_outline', title: 'Worst Vice Captain Picker', winner: worstVc[0].name, value: `${worstVc[0].total} VC pts` });

    // 9. Pity Award (Most 8th Place Finishes)
    const eighthCounts = users.map(([, u]) => ({
      name: u.name, count: u.matches.filter(m => m.rank === 8).length,
    })).sort((a, b) => b.count - a.count);
    if (eighthCounts[0] && eighthCounts[0].count > 0) awards.push({ type: 'pity_award', icon: 'sentiment_dissatisfied', title: 'Pity Award (Most 8th Places)', winner: eighthCounts[0].name, value: `${eighthCounts[0].count} times 8th` });

    // 10. Position Lover (Max times at same position)
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

    // 11. Jack of All Trades (Most distinct positions)
    const jackOfAll = users.map(([, u]) => ({
      name: u.name, positions: new Set(u.matches.map(m => m.rank)).size,
    })).sort((a, b) => b.positions - a.positions);
    if (jackOfAll[0]) awards.push({ type: 'jack_of_all', icon: 'shuffle', title: 'Jack of All Trades', winner: jackOfAll[0].name, value: `${jackOfAll[0].positions} different positions` });

    // 12. The Batsman (Highest BAT + WK points)
    const batTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.batPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (batTotals[0]) awards.push({ type: 'the_batsman', icon: 'sports_cricket', title: 'The Batsman', winner: batTotals[0].name, value: `${batTotals[0].total} pts from BAT/WK` });

    // 13. The Bowler (Highest BOWL points)
    const bowlTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.bowlPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (bowlTotals[0]) awards.push({ type: 'the_bowler', icon: 'sports_baseball', title: 'The Bowler', winner: bowlTotals[0].name, value: `${bowlTotals[0].total} pts from bowlers` });

    // 14. The All-Rounder (Highest AR points only)
    const arTotals = users.map(([, u]) => ({
      name: u.name, total: Math.round(u.matches.reduce((s, m) => s + m.arPts, 0) * 10) / 10,
    })).sort((a, b) => b.total - a.total);
    if (arTotals[0]) awards.push({ type: 'the_allrounder', icon: 'psychology', title: 'The All-Rounder', winner: arTotals[0].name, value: `${arTotals[0].total} pts from all-rounders` });

    // 15. Best Win Predictor
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
    if (bestPredictors[0]) awards.push({ type: 'best_predictor', icon: 'psychology_alt', title: 'Best Win Predictor', winner: bestPredictors[0].name, value: `${bestPredictors[0].pct}% (${bestPredictors[0].correct}/${totalCompleted})` });

    // 16. Worst Win Predictor
    const worstPredictors = [...allPredictors].sort((a, b) => a.correct - b.correct || a.pct - b.pct);
    if (worstPredictors[0]) awards.push({ type: 'worst_predictor', icon: 'do_not_disturb', title: 'Worst Win Predictor', winner: worstPredictors[0].name, value: `${worstPredictors[0].pct}% (${worstPredictors[0].correct}/${totalCompleted})` });

    // 17. Lowest Top 7 Finishes
    const top7Counts = users.map(([, u]) => ({
      name: u.name, count: u.matches.filter(m => m.rank <= 7).length, total: u.matches.length,
    })).sort((a, b) => a.count - b.count);
    if (top7Counts[0]) awards.push({ type: 'lowest_top7', icon: 'arrow_downward', title: 'Lowest Top 7 Finishes', winner: top7Counts[0].name, value: `${top7Counts[0].count}/${top7Counts[0].total} in top 7` });

    // 18. Lowest Bowling Points
    const bowlLowest = [...bowlTotals].sort((a, b) => a.total - b.total);
    if (bowlLowest[0]) awards.push({ type: 'lowest_bowling', icon: 'sports_baseball', title: 'Lowest Bowling Points', winner: bowlLowest[0].name, value: `${bowlLowest[0].total} pts from bowlers` });

    // 19. Lowest Batting Points
    const batLowest = [...batTotals].sort((a, b) => a.total - b.total);
    if (batLowest[0]) awards.push({ type: 'lowest_batting', icon: 'sports_cricket', title: 'Lowest Batting Points', winner: batLowest[0].name, value: `${batLowest[0].total} pts from BAT/WK` });

    // 20. Lowest All-Rounder Points
    const arLowest = [...arTotals].sort((a, b) => a.total - b.total);
    if (arLowest[0]) awards.push({ type: 'lowest_allrounder', icon: 'psychology', title: 'Lowest All-Rounder Points', winner: arLowest[0].name, value: `${arLowest[0].total} pts from all-rounders` });

    res.json({ awards, matchesPlayed: matchIds.length });
  } catch (err) {
    console.error('Season awards error:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getSeasonInsights, getSeasonAwards };
