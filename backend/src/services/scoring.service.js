/**
 * Fantasy Points Calculation Engine
 * Implements all rules from REQUIREMENTS.MD Section 3.
 *
 * @param {Object} perf  - PlayerPerformance document (plain object or Mongoose doc)
 * @param {string} role  - Player role: 'WK' | 'BAT' | 'AR' | 'BOWL'
 * @returns {number}     - Total fantasy points (not yet multiplied for C/VC)
 */
function calculateFantasyPoints(perf, role) {
  let points = 0;

  // Destructure with defaults to guard against undefined/null (prevents NaN)
  const {
    runs = 0, ballsFaced = 0, fours = 0, sixes = 0,
    isDismissed = false, didBat = false,
    oversBowled = 0, runsConceded = 0, wickets = 0,
    maidens = 0, lbwBowledWickets = 0,
    catches = 0, stumpings = 0, runOutDirect = 0, runOutIndirect = 0,
  } = perf;

  // ─── 3.1 Batting Points ────────────────────────────────────────────────────
  if (didBat) {
    points += runs;                                   // +1 per run
    points += fours;                                  // +1 per four
    points += sixes * 2;                              // +2 per six

    // Milestone bonuses
    if (runs >= 100) points += 16;                    // century
    else if (runs >= 50) points += 8;                 // half-century

    // Duck penalty (not for pure bowlers)
    if (isDismissed && runs === 0 && role !== 'BOWL') {
      points -= 2;
    }

    // Batting Strike Rate modifier (min 10 balls faced)
    // Full spectrum: no dead zone between 70-130
    if (ballsFaced >= 10) {
      const sr = (runs / ballsFaced) * 100;
      if (sr >= 200)      points += 8;   // monster innings
      else if (sr >= 150) points += 6;   // explosive
      else if (sr >= 130) points += 4;   // very fast
      else if (sr >= 110) points += 2;   // above par
      // 90-110 = par, no modifier
      else if (sr >= 70)  points -= 4;   // slow innings
      else if (sr >= 50)  points -= 6;   // very slow
      else                points -= 8;   // anchored to death
    }
  }

  // ─── 3.2 Bowling Points ────────────────────────────────────────────────────
  if (oversBowled > 0) {
    points += wickets * 25;                           // +25 per wicket (no run-outs)
    points += lbwBowledWickets * 8;                   // +8 bonus per LBW/Bowled wicket
    points += maidens * 12;                           // +12 per maiden over

    // Haul milestones
    if (wickets >= 5) points += 16;
    else if (wickets >= 4) points += 8;

    // Bowling Economy Rate modifier (min 2 overs)
    // Rewards tight bowling heavily — <4 eco in T20 is elite
    if (oversBowled >= 2) {
      const economy = runsConceded / oversBowled;
      if (economy < 4)       points += 10;  // elite spell
      else if (economy < 5)  points += 8;   // excellent
      else if (economy < 6)  points += 6;   // very good
      else if (economy < 8)  points += 4;   // good control
      // 8-10 = par, no modifier
      else if (economy <= 11) points -= 2;  // expensive
      else if (economy <= 12) points -= 4;  // very expensive
      else                    points -= 6;  // getting smashed
    }
  }

  // ─── 3.3 Fielding Points ──────────────────────────────────────────────────
  points += catches * 8;                              // +8 per catch

  // Bonus for 3+ catches in a single match
  if (catches >= 3) points += 8;

  points += stumpings * 12;                           // +12 per stumping
  points += runOutDirect * 10;                        // +10 direct run-out
  points += runOutIndirect * 6;                       // +6 indirect run-out (throw or catch)

  return points;
}

/**
 * Apply captain (2x) or vice-captain (1.5x) multiplier.
 */
function applyMultiplier(points, isCaptain, isViceCaptain) {
  if (isCaptain) return points * 2;
  if (isViceCaptain) return points * 1.5;
  return points;
}

module.exports = { calculateFantasyPoints, applyMultiplier };
