const Prediction = require('../models/Prediction.model');

/**
 * Evaluate all predictions for a completed match.
 * Extracts match result and updates predictions accordingly.
 *
 * predictionType 'winner': +10 pts if predictedWinner matches result winner
 * predictionType 'superover': +20 pts if match went to super over
 *
 * @param {string} matchId - Match ID
 * @param {string} result - Match result string (e.g., "CSK won by 5 wickets", "MI won in super over")
 * @returns {{ correctCount: number, superoverCorrect: number, totalPoints: number }}
 */
async function evaluatePredictions(matchId, result) {
  if (!result) return { correctCount: 0, superoverCorrect: 0, totalPoints: 0 };

  const hasSuperover = result.toLowerCase().includes('super over') || result.toLowerCase().includes('superover');
  const winningTeam = extractWinningTeam(result);

  if (!winningTeam) {
    console.warn(`Could not extract winning team from result: ${result}`);
    return { correctCount: 0, superoverCorrect: 0, totalPoints: 0 };
  }

  // Get all predictions for this match
  const predictions = await Prediction.find({ matchId });

  let correctCount = 0;
  let superoverCorrect = 0;
  let totalPoints = 0;

  // Update each prediction
  for (const pred of predictions) {
    let isCorrect = false;
    let bonusPoints = 0;

    if (pred.predictionType === 'superover') {
      // Superover bet: +20 if match went to super over, regardless of which team prediction
      isCorrect = hasSuperover;
      bonusPoints = isCorrect ? 20 : 0;
      if (isCorrect) superoverCorrect++;
    } else {
      // Normal winner prediction: +10 if predicted team won
      isCorrect = pred.predictedWinner === winningTeam;
      bonusPoints = isCorrect ? 10 : 0;
    }

    pred.isCorrect = isCorrect;
    pred.bonusPoints = bonusPoints;
    await pred.save();

    if (isCorrect) {
      correctCount++;
      totalPoints += bonusPoints;
    }
  }

  return { correctCount, superoverCorrect, totalPoints };
}

/**
 * Extract winning team franchise from match result string.
 * Supports formats like: "CSK won by 5 wickets", "MI won in super over", etc.
 */
function extractWinningTeam(result) {
  if (!result) return null;

  // Valid franchises
  const franchises = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'RR', 'PBKS', 'DC', 'GT', 'LSG'];

  // Check if result starts with a franchise name
  for (const franchise of franchises) {
    if (result.startsWith(franchise)) {
      return franchise;
    }
  }

  return null;
}

module.exports = { evaluatePredictions, extractWinningTeam };
