/**
 * WhatsApp Notification Service — Personal DMs
 * Uses Meet's Baileys bot at wa.dotsai.cloud
 *
 * Env: WHATSAPP_API_URL, WHATSAPP_API_TOKEN
 */

const WA_URL = () => process.env.WHATSAPP_API_URL || 'https://wa.dotsai.cloud';
const WA_TOKEN = () => process.env.WHATSAPP_API_TOKEN;

async function sendDM(phone, message) {
  if (!phone) return false;

  try {
    const res = await fetch(`${WA_URL()}/api/send/text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WA_TOKEN()}`,
      },
      body: JSON.stringify({ to: phone, message }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[WhatsApp] DM to ${phone} failed:`, data);
      return false;
    }
    console.log(`[WhatsApp] DM sent to ${phone}`);
    return true;
  } catch (err) {
    console.error(`[WhatsApp] Error sending to ${phone}:`, err.message);
    return false;
  }
}

/**
 * Send deadline reminder DM to each user who hasn't submitted.
 * @param {Object} match - Match doc
 * @param {Array<{name: string, phone: string}>} missingUsers - Users without teams
 */
async function sendDeadlineReminders(match, missingUsers) {
  const timeLeft = Math.round((new Date(match.deadline) - Date.now()) / (60 * 1000));
  const timeStr = timeLeft > 60 ? `${Math.round(timeLeft / 60)}h` : `${timeLeft}min`;

  const results = [];
  for (const user of missingUsers) {
    if (!user.phone) continue;
    const msg =
      `🏏 *${match.team1} vs ${match.team2}* — Deadline in *${timeStr}*!\n\n` +
      `Hey ${user.name}, you haven't picked your fantasy team yet. Don't miss out!`;
    results.push(await sendDM(user.phone, msg));
  }
  return results;
}

/**
 * Send live score update DM to all league members.
 */
async function sendScoreUpdates(match, allUsers, topUsers) {
  const leaderboard = topUsers
    .slice(0, 5)
    .map((u, i) => `${i + 1}. ${u.userName} — ${u.totalPoints} pts`)
    .join('\n');

  for (const user of allUsers) {
    if (!user.phone) continue;
    // Find this user's position
    const myRank = topUsers.findIndex((t) => String(t.userId) === String(user._id));
    const myLine = myRank >= 0
      ? `\nYou're #${myRank + 1} with ${topUsers[myRank].totalPoints} pts`
      : '';

    const msg =
      `📊 *Live — ${match.team1} vs ${match.team2}*\n\n` +
      `${leaderboard}${myLine}\n\n` +
      `Points updating live!`;
    await sendDM(user.phone, msg);
  }
}

/**
 * Send match completed summary DM to all league members.
 */
async function sendMatchSummaries(match, allUsers, topUsers) {
  const medals = ['🥇', '🥈', '🥉'];
  const podium = topUsers
    .slice(0, 3)
    .map((u, i) => `${medals[i]} ${u.userName} — ${u.totalPoints} pts`)
    .join('\n');

  for (const user of allUsers) {
    if (!user.phone) continue;
    const myRank = topUsers.findIndex((t) => String(t.userId) === String(user._id));
    const myLine = myRank >= 0
      ? `\nYou finished #${myRank + 1} with ${topUsers[myRank].totalPoints} pts`
      : '';

    const msg =
      `🏆 *${match.team1} vs ${match.team2}* — Match Complete!\n\n` +
      `${podium}${myLine}\n\n` +
      `Full leaderboard in the app.`;
    await sendDM(user.phone, msg);
  }
}

module.exports = { sendDM, sendDeadlineReminders, sendScoreUpdates, sendMatchSummaries };
