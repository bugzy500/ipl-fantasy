/**
 * WhatsApp Notification Service
 * Uses Meet's Baileys bot at wa.dotsai.cloud
 *
 * Env: WHATSAPP_API_URL, WHATSAPP_API_TOKEN, WHATSAPP_GROUP_ID
 */

const WA_URL = () => process.env.WHATSAPP_API_URL || 'https://wa.dotsai.cloud';
const WA_TOKEN = () => process.env.WHATSAPP_API_TOKEN;
const GROUP_ID = () => process.env.WHATSAPP_GROUP_ID; // e.g. "120363xxxxx@g.us"

async function sendGroupMessage(message, mentions = []) {
  const url = `${WA_URL()}/api/send/text`;
  const body = {
    to: GROUP_ID(),
    message,
  };
  // If we have phone numbers to tag, add mentions
  if (mentions.length > 0) {
    body.mentions = mentions; // array of JIDs like ["918320065658@s.whatsapp.net"]
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WA_TOKEN()}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[WhatsApp] Send failed:', data);
      return false;
    }
    console.log('[WhatsApp] Message sent to group');
    return true;
  } catch (err) {
    console.error('[WhatsApp] Error:', err.message);
    return false;
  }
}

/**
 * Send deadline reminder to group, tagging users who haven't submitted.
 * @param {Object} match - Match doc
 * @param {Array<{name: string, phone: string}>} missingUsers - Users without teams
 */
async function sendDeadlineReminder(match, missingUsers) {
  if (missingUsers.length === 0) return;

  const timeLeft = Math.round((new Date(match.deadline) - Date.now()) / (60 * 1000));
  const timeStr = timeLeft > 60 ? `${Math.round(timeLeft / 60)}h` : `${timeLeft}min`;

  const tags = missingUsers.map((u) => `@${u.phone}`).join(', ');
  const mentions = missingUsers
    .filter((u) => u.phone)
    .map((u) => `${u.phone}@s.whatsapp.net`);

  const message =
    `🏏 *${match.team1} vs ${match.team2}* — Deadline in *${timeStr}*!\n\n` +
    `${tags}\n` +
    `You haven't picked your fantasy team yet. Don't miss out!`;

  return sendGroupMessage(message, mentions);
}

/**
 * Send live score update to group.
 */
async function sendScoreUpdate(match, topUsers) {
  const leaderboard = topUsers
    .slice(0, 5)
    .map((u, i) => `${i + 1}. ${u.userName} — ${u.totalPoints} pts`)
    .join('\n');

  const message =
    `📊 *Live Update — ${match.team1} vs ${match.team2}*\n\n` +
    `${leaderboard}\n\n` +
    `Points are live! Check the app for full details.`;

  return sendGroupMessage(message);
}

/**
 * Send match completed summary to group.
 */
async function sendMatchSummary(match, winner, topUsers) {
  const leaderboard = topUsers
    .slice(0, 3)
    .map((u, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      return `${medals[i]} ${u.userName} — ${u.totalPoints} pts`;
    })
    .join('\n');

  const message =
    `🏆 *${match.team1} vs ${match.team2}* — Match Complete!\n\n` +
    `${leaderboard}\n\n` +
    `Full leaderboard in the app.`;

  return sendGroupMessage(message);
}

module.exports = { sendGroupMessage, sendDeadlineReminder, sendScoreUpdate, sendMatchSummary };
