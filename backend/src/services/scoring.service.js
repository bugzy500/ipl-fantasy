const STRIKE_RATE_MIN_BALLS = 10;
const ECONOMY_MIN_OVERS = 2;

const STRIKE_RATE_RULES = Object.freeze([
  { key: 'gt_170', label: 'Strike rate above 170', note: 'Min 10 balls faced', points: 6, matches: (sr) => sr > 170, detail: '> 170' },
  { key: 'sr_150_170', label: 'Strike rate 150.01 - 170', points: 4, matches: (sr) => sr > 150, detail: '150.01 - 170' },
  { key: 'sr_130_150', label: 'Strike rate 130 - 150', points: 2, matches: (sr) => sr >= 130, detail: '130 - 150' },
  { key: 'sr_60_70', label: 'Strike rate 60 - 70', points: -2, matches: (sr) => sr >= 60 && sr <= 70, detail: '60 - 70' },
  { key: 'sr_50_59', label: 'Strike rate 50 - 59.99', points: -4, matches: (sr) => sr >= 50 && sr < 60, detail: '50 - 59.99' },
  { key: 'lt_50', label: 'Strike rate below 50', points: -6, matches: (sr) => sr < 50, detail: '< 50' },
  { key: 'neutral', label: 'Strike rate 70.01 - 129.99', points: 0, matches: () => true, detail: 'No modifier' },
]);

const ECONOMY_RULES = Object.freeze([
  { key: 'lt_5', label: 'Economy below 5', note: 'Min 2 overs bowled', points: 6, matches: (econ) => econ < 5, detail: '< 5' },
  { key: 'eco_5_599', label: 'Economy 5 - 5.99', points: 4, matches: (econ) => econ >= 5 && econ < 6, detail: '5 - 5.99' },
  { key: 'eco_6_7', label: 'Economy 6 - 7', points: 2, matches: (econ) => econ >= 6 && econ <= 7, detail: '6 - 7' },
  { key: 'eco_10_11', label: 'Economy 10 - 11', points: -2, matches: (econ) => econ >= 10 && econ <= 11, detail: '10 - 11' },
  { key: 'eco_1101_12', label: 'Economy 11.01 - 12', points: -4, matches: (econ) => econ > 11 && econ <= 12, detail: '11.01 - 12' },
  { key: 'gt_12', label: 'Economy above 12', points: -6, matches: (econ) => econ > 12, detail: '> 12' },
  { key: 'neutral', label: 'Economy 7.01 - 9.99', points: 0, matches: () => true, detail: 'No modifier' },
]);

const RULES_RESPONSE = Object.freeze({
  thresholds: {
    strikeRateMinBalls: STRIKE_RATE_MIN_BALLS,
    economyMinOvers: ECONOMY_MIN_OVERS,
  },
  sections: [
    {
      key: 'batting',
      title: 'Batting',
      icon: 'sports_cricket',
      color: '#3B82F6',
      rules: [
        { label: 'Per run scored', points: 1, displayPoints: '+1' },
        { label: 'Per boundary (4)', points: 1, displayPoints: '+1 bonus' },
        { label: 'Per six', points: 2, displayPoints: '+2 bonus' },
        { label: 'Half-century (50 runs)', points: 8, displayPoints: '+8' },
        { label: 'Century (100 runs)', points: 16, displayPoints: '+16' },
        { label: 'Duck penalty', points: -2, displayPoints: '-2', note: 'Applies only to BAT, WK, and AR who are dismissed for 0.' },
        ...STRIKE_RATE_RULES.map((rule) => ({
          label: rule.label,
          points: rule.points,
          displayPoints: formatPoints(rule.points),
          note: rule.note,
        })),
      ],
    },
    {
      key: 'bowling',
      title: 'Bowling',
      icon: 'sports_baseball',
      color: '#E8534A',
      rules: [
        { label: 'Per wicket', points: 25, displayPoints: '+25', note: 'Run-outs do not count as wickets.' },
        { label: 'LBW / Bowled bonus (per wicket)', points: 8, displayPoints: '+8' },
        { label: 'Per maiden over', points: 12, displayPoints: '+12' },
        { label: '4-wicket haul', points: 8, displayPoints: '+8' },
        { label: '5-wicket haul', points: 16, displayPoints: '+16' },
        ...ECONOMY_RULES.map((rule) => ({
          label: rule.label,
          points: rule.points,
          displayPoints: formatPoints(rule.points),
          note: rule.note,
        })),
      ],
    },
    {
      key: 'fielding',
      title: 'Fielding',
      icon: 'sports_handball',
      color: '#22C55E',
      rules: [
        { label: 'Per catch', points: 8, displayPoints: '+8' },
        { label: '3+ catches in a match', points: 4, displayPoints: '+4 bonus' },
        { label: 'Per stumping', points: 12, displayPoints: '+12' },
        { label: 'Direct run-out', points: 12, displayPoints: '+12' },
        { label: 'Indirect run-out (throw or catch)', points: 6, displayPoints: '+6' },
      ],
    },
  ],
  multipliers: [
    { key: 'captain', label: 'Captain', multiplier: 2, displayMultiplier: '2x', note: 'Captain scores double fantasy points.' },
    { key: 'viceCaptain', label: 'Vice-Captain', multiplier: 1.5, displayMultiplier: '1.5x', note: 'Vice-Captain scores 1.5x fantasy points.' },
  ],
});

function formatPoints(points) {
  return points > 0 ? `+${points}` : `${points}`;
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function makeItem(label, detail, points) {
  return { label, detail, points };
}

function makeSection(key, label, items) {
  const subtotal = items.reduce((sum, item) => sum + item.points, 0);
  return { key, label, subtotal, items };
}

function getStrikeRateRule(runs, ballsFaced) {
  if (ballsFaced < STRIKE_RATE_MIN_BALLS) return null;
  const strikeRate = (runs / ballsFaced) * 100;
  const matchedRule = STRIKE_RATE_RULES.find((rule) => rule.matches(strikeRate));
  return {
    metric: roundMetric(strikeRate),
    rule: matchedRule,
  };
}

function getEconomyRule(runsConceded, oversBowled) {
  if (oversBowled < ECONOMY_MIN_OVERS) return null;
  const economy = runsConceded / oversBowled;
  const matchedRule = ECONOMY_RULES.find((rule) => rule.matches(economy));
  return {
    metric: roundMetric(economy),
    rule: matchedRule,
  };
}

function buildFantasyPointsBreakdown(perf, role) {
  const {
    runs = 0, ballsFaced = 0, fours = 0, sixes = 0,
    isDismissed = false, didBat = false,
    oversBowled = 0, runsConceded = 0, wickets = 0,
    maidens = 0, lbwBowledWickets = 0,
    catches = 0, stumpings = 0, runOutDirect = 0, runOutIndirect = 0,
  } = perf;

  const sections = [];

  if (didBat) {
    const battingItems = [
      makeItem('Runs scored', `${runs} run${runs === 1 ? '' : 's'} x 1`, runs),
    ];

    if (fours > 0) {
      battingItems.push(makeItem('Boundary bonus', `${fours} four${fours === 1 ? '' : 's'} x 1`, fours));
    }
    if (sixes > 0) {
      battingItems.push(makeItem('Six bonus', `${sixes} six${sixes === 1 ? '' : 'es'} x 2`, sixes * 2));
    }
    if (runs >= 100) {
      battingItems.push(makeItem('Century bonus', '100+ runs', 16));
    } else if (runs >= 50) {
      battingItems.push(makeItem('Half-century bonus', '50+ runs', 8));
    }
    if (isDismissed && runs === 0 && role !== 'BOWL') {
      battingItems.push(makeItem('Duck penalty', 'Dismissed for 0', -2));
    }

    const strikeRateRule = getStrikeRateRule(runs, ballsFaced);
    if (strikeRateRule) {
      battingItems.push(
        makeItem(
          'Strike-rate modifier',
          `SR ${strikeRateRule.metric} (${strikeRateRule.rule.detail})`,
          strikeRateRule.rule.points
        )
      );
    }

    sections.push(makeSection('batting', 'Batting', battingItems));
  }

  if (oversBowled > 0) {
    const bowlingItems = [];

    if (wickets > 0) {
      bowlingItems.push(makeItem('Wickets', `${wickets} wicket${wickets === 1 ? '' : 's'} x 25`, wickets * 25));
    }
    if (lbwBowledWickets > 0) {
      bowlingItems.push(makeItem('LBW / bowled bonus', `${lbwBowledWickets} wicket${lbwBowledWickets === 1 ? '' : 's'} x 8`, lbwBowledWickets * 8));
    }
    if (maidens > 0) {
      bowlingItems.push(makeItem('Maiden overs', `${maidens} maiden${maidens === 1 ? '' : 's'} x 12`, maidens * 12));
    }
    if (wickets >= 5) {
      bowlingItems.push(makeItem('5-wicket haul bonus', `${wickets} wickets`, 16));
    } else if (wickets >= 4) {
      bowlingItems.push(makeItem('4-wicket haul bonus', `${wickets} wickets`, 8));
    }

    const economyRule = getEconomyRule(runsConceded, oversBowled);
    if (economyRule) {
      bowlingItems.push(
        makeItem(
          'Economy modifier',
          `Econ ${economyRule.metric} (${economyRule.rule.detail})`,
          economyRule.rule.points
        )
      );
    }

    if (bowlingItems.length > 0) {
      sections.push(makeSection('bowling', 'Bowling', bowlingItems));
    }
  }

  const fieldingItems = [];
  if (catches > 0) {
    fieldingItems.push(makeItem('Catches', `${catches} catch${catches === 1 ? '' : 'es'} x 8`, catches * 8));
    if (catches >= 3) {
      fieldingItems.push(makeItem('3-catch bonus', `${catches} catches`, 4));
    }
  }
  if (stumpings > 0) {
    fieldingItems.push(makeItem('Stumpings', `${stumpings} stumping${stumpings === 1 ? '' : 's'} x 12`, stumpings * 12));
  }
  if (runOutDirect > 0) {
    fieldingItems.push(makeItem('Direct run-outs', `${runOutDirect} direct run-out${runOutDirect === 1 ? '' : 's'} x 12`, runOutDirect * 12));
  }
  if (runOutIndirect > 0) {
    fieldingItems.push(makeItem('Indirect run-outs', `${runOutIndirect} assist${runOutIndirect === 1 ? '' : 's'} x 6`, runOutIndirect * 6));
  }
  if (fieldingItems.length > 0) {
    sections.push(makeSection('fielding', 'Fielding', fieldingItems));
  }

  const total = sections.reduce((sum, section) => sum + section.subtotal, 0);

  return { total, sections };
}

function calculateFantasyPoints(perf, role) {
  return buildFantasyPointsBreakdown(perf, role).total;
}

function getScoringRules() {
  return RULES_RESPONSE;
}

function applyMultiplier(points, isCaptain, isViceCaptain) {
  if (isCaptain) return points * 2;
  if (isViceCaptain) return points * 1.5;
  return points;
}

module.exports = {
  applyMultiplier,
  buildFantasyPointsBreakdown,
  calculateFantasyPoints,
  getScoringRules,
};
