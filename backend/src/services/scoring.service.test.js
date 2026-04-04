const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyMultiplier,
  buildFantasyPointsBreakdown,
  calculateFantasyPoints,
  getScoringRules,
} = require('./scoring.service');

test('batting breakdown matches requirements tiers', () => {
  const perf = {
    runs: 60,
    ballsFaced: 30,
    fours: 6,
    sixes: 3,
    isDismissed: true,
    didBat: true,
  };

  const breakdown = buildFantasyPointsBreakdown(perf, 'BAT');

  assert.equal(breakdown.total, 86);
  assert.deepEqual(
    breakdown.sections[0].items.map((item) => ({ label: item.label, points: item.points })),
    [
      { label: 'Runs scored', points: 60 },
      { label: 'Boundary bonus', points: 6 },
      { label: 'Six bonus', points: 6 },
      { label: 'Half-century bonus', points: 8 },
      { label: 'Strike-rate modifier', points: 6 },
    ]
  );
  assert.equal(calculateFantasyPoints(perf, 'BAT'), 86);
});

test('pure bowlers do not get duck penalty', () => {
  const perf = {
    runs: 0,
    ballsFaced: 12,
    isDismissed: true,
    didBat: true,
  };

  const breakdown = buildFantasyPointsBreakdown(perf, 'BOWL');
  const duckPenalty = breakdown.sections[0].items.find((item) => item.label === 'Duck penalty');

  assert.equal(duckPenalty, undefined);
  assert.equal(breakdown.total, -6);
});

test('bowling breakdown uses documented economy tiers', () => {
  const perf = {
    oversBowled: 4,
    runsConceded: 18,
    wickets: 4,
    maidens: 1,
    lbwBowledWickets: 2,
  };

  const breakdown = buildFantasyPointsBreakdown(perf, 'BOWL');

  assert.equal(breakdown.total, 142);
  assert.deepEqual(
    breakdown.sections[0].items.map((item) => ({ label: item.label, points: item.points })),
    [
      { label: 'Wickets', points: 100 },
      { label: 'LBW / bowled bonus', points: 16 },
      { label: 'Maiden overs', points: 12 },
      { label: '4-wicket haul bonus', points: 8 },
      { label: 'Economy modifier', points: 6 },
    ]
  );
});

test('fielding breakdown matches documented bonuses', () => {
  const perf = {
    catches: 3,
    stumpings: 1,
    runOutDirect: 1,
    runOutIndirect: 2,
  };

  const breakdown = buildFantasyPointsBreakdown(perf, 'WK');

  assert.equal(breakdown.total, 64);
  assert.deepEqual(
    breakdown.sections[0].items.map((item) => ({ label: item.label, points: item.points })),
    [
      { label: 'Catches', points: 24 },
      { label: '3-catch bonus', points: 4 },
      { label: 'Stumpings', points: 12 },
      { label: 'Direct run-outs', points: 12 },
      { label: 'Indirect run-outs', points: 12 },
    ]
  );
});

test('rules contract matches captain multipliers and thresholds', () => {
  const rules = getScoringRules();

  assert.equal(rules.thresholds.strikeRateMinBalls, 10);
  assert.equal(rules.thresholds.economyMinOvers, 2);
  assert.equal(rules.multipliers[0].displayMultiplier, '2x');
  assert.equal(rules.multipliers[1].displayMultiplier, '1.5x');
  assert.equal(applyMultiplier(40, true, false), 80);
  assert.equal(applyMultiplier(40, false, true), 60);
});
