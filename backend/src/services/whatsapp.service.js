/**
 * WhatsApp Notification Service — Personal DMs
 * Uses Meet's Baileys bot at wa.dotsai.cloud
 *
 * Env: WHATSAPP_API_URL, WHATSAPP_API_TOKEN
 */

const WA_URL = () => process.env.WHATSAPP_API_URL || 'https://wa.dotsai.cloud';
const WA_TOKEN = () => process.env.WHATSAPP_API_TOKEN;
const SPL_GROUP_JID = '120363407548600267@g.us';

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

async function sendGroup(message) {
  try {
    const res = await fetch(`${WA_URL()}/api/send/text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WA_TOKEN()}`,
      },
      body: JSON.stringify({ to: SPL_GROUP_JID, message }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`[WhatsApp] Group msg failed:`, data);
      return false;
    }
    console.log(`[WhatsApp] Group msg sent`);
    return true;
  } catch (err) {
    console.error(`[WhatsApp] Group error:`, err.message);
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
 * Send live score update to SPL group.
 */
async function sendScoreUpdates(match, allUsers, topUsers) {
  const leaderboard = topUsers
    .slice(0, 15)
    .map((u, i) => `${i + 1}. ${u.userName} — ${u.totalPoints} pts`)
    .join('\n');

  const msg =
    `📊 *Live — ${match.team1} vs ${match.team2}*\n\n` +
    `*Leaderboard:*\n${leaderboard}\n\n` +
    `Points updating live!`;
  await sendGroup(msg);
}

/**
 * Send match completed summary to SPL group.
 */
async function sendMatchSummaries(match, allUsers, topUsers) {
  const medals = ['🥇', '🥈', '🥉'];
  const podium = topUsers
    .slice(0, 3)
    .map((u, i) => `${medals[i]} ${u.userName} — ${u.totalPoints} pts`)
    .join('\n');

  const msg =
    `🏆 *${match.team1} vs ${match.team2}* — Match Complete!\n\n` +
    `${podium}\n\n` +
    `Full leaderboard in the app.`;
  await sendGroup(msg);
}

module.exports = { sendDM, sendGroup, sendDeadlineReminders, sendScoreUpdates, sendMatchSummaries };
