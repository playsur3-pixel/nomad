const DISCORD_API = "https://discord.com/api/v10";

const TARGET_USER_ID = "319045529373900800";
const GOODNIGHT_MESSAGE = "@everyone Bonne nuit tout le monde, à plus tard ! Bisous";
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

async function discordFetch(path, botToken, options = {}) {
  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${text}`);
  }

  return json;
}

async function getGuildVoiceStates(guildId, botToken) {
  return discordFetch(`/guilds/${guildId}/voice-states`, botToken);
}

async function getRecentMessages(channelId, botToken, limit = 10) {
  return discordFetch(`/channels/${channelId}/messages?limit=${limit}`, botToken);
}

async function sendMessage(channelId, botToken, content) {
  return discordFetch(`/channels/${channelId}/messages`, botToken, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: ["everyone"] },
    }),
  });
}

function hasRecentlyPostedSameMessage(messages) {
  const now = Date.now();

  return Array.isArray(messages) && messages.some((message) => {
    if (message?.content !== GOODNIGHT_MESSAGE) return false;
    if (!message?.author?.bot) return false;

    const timestamp = new Date(message.timestamp).getTime();
    if (Number.isNaN(timestamp)) return false;

    return now - timestamp <= DUPLICATE_WINDOW_MS;
  });
}

export default async () => {
  const guildId = process.env.DISCORD_GUILD_ID;
  const channelId = process.env.DISCORD_TAVERNE_CHANNEL_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!guildId || !channelId || !botToken) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Variables d'environnement manquantes",
        required: [
          "DISCORD_GUILD_ID",
          "DISCORD_TAVERNE_CHANNEL_ID",
          "DISCORD_BOT_TOKEN"
        ]
      }, null, 2),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  try {
    const voiceStates = await getGuildVoiceStates(guildId, botToken);
    const targetState = Array.isArray(voiceStates)
      ? voiceStates.find((state) => String(state?.user_id) === TARGET_USER_ID)
      : null;

    const isInVoice = Boolean(targetState?.channel_id);

    if (isInVoice) {
      return new Response(
        JSON.stringify({
          ok: true,
          action: "none",
          reason: "target_still_in_voice",
          targetUserId: TARGET_USER_ID,
          channelId: targetState.channel_id,
        }, null, 2),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    const recentMessages = await getRecentMessages(channelId, botToken, 10);

    if (hasRecentlyPostedSameMessage(recentMessages)) {
      return new Response(
        JSON.stringify({
          ok: true,
          action: "none",
          reason: "duplicate_prevented",
        }, null, 2),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    await sendMessage(channelId, botToken, GOODNIGHT_MESSAGE);

    return new Response(
      JSON.stringify({
        ok: true,
        action: "message_sent",
        targetUserId: TARGET_USER_ID,
      }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error?.message || String(error),
      }, null, 2),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
};

export const config = {
  schedule: "*/1 * * * *"
};
