const FantasyTeam = require('../models/FantasyTeam.model');
const PlayerPerformance = require('../models/PlayerPerformance.model');
const Match = require('../models/Match.model');
const User = require('../models/User.model');
const Prediction = require('../models/Prediction.model');

// GET /api/stats/season-insights
// Returns leaderboard variations: best captain, most consistent, biggest gainer, best predictor
const getSeasonInsights = async (req, res) => {
  try {
    const completedMatches = await Match.find({ status: 'completed' }).select('_id team1 team2 result');
    const matchIds = completedMatches.map(m => m._id);

    if (matchIds.length === 0) return res.json({ insights: [], money: [] });

    const allTeams = await FantasyTeam.find({ matchId: { $in: matchIds } })
      .populate('userId', 'name')
      .populate('captain', 'name');

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
    const predictions = await Prediction.find({ matchId: { $in: matchIds }, isCorrect: true })
      .populate('userId', 'name');
    const predCountByUser = {};
    for (const p of predictions) {
      const uid = String(p.userId._id);
      if (!predCountByUser[uid]) predCountByUser[uid] = { name: p.userId.name, count: 0 };
      predCountByUser[uid].count++;
    }
    const bestPredictor = Object.entries(predCountByUser)
      .map(([id, d]) => ({ userId: id, userName: d.name, value: d.count, label: `${d.count}/${matchIds.length} correct` }))
      .sort((a, b) => b.value - a.value)[0] || null;

    // --- Virtual Money (100 rs pot per match, winner gets pool, split if tie) ---
    const MEMBERS_COUNT = await User.countDocuments();
    const POT_PER_MATCH = 100;
    const moneyByUser = {};

    for (const matchId of matchIds) {
      const matchTeams = allTeams.filter(t => String(t.matchId) === String(matchId));
      if (matchTeams.length === 0) continue;

      const totalPot = matchTeams.length * POT_PER_MATCH;
      const maxPts = Math.max(...matchTeams.map(t => t.totalPoints));
      const winners = matchTeams.filter(t => t.totalPoints === maxPts);
      const winShare = totalPot / winners.length;

      for (const t of matchTeams) {
        const uid = String(t.userId._id);
        if (!moneyByUser[uid]) moneyByUser[uid] = { name: t.userId.name, invested: 0, won: 0 };
        moneyByUser[uid].invested += POT_PER_MATCH;
        if (winners.some(w => String(w.userId._id) === uid)) {
          moneyByUser[uid].won += winShare;
        }
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

    res.json({ insights, money });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getSeasonInsights };
