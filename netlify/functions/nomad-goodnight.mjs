const DISCORD_API = "https://discord.com/api/v10";

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TARGET_USER_ID = "319045529373900800";
const TAVERNE_CHANNEL_ID = process.env.DISCORD_TAVERNE_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const GOODNIGHT_MESSAGE = "@everyone Bonne nuit tout le monde, à plus tard ! Bisous";
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

async function discordFetch(path, options = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function getGuildVoiceStates() {
  return discordFetch(`/guilds/${GUILD_ID}/voice-states`);
}

async function getRecentMessages(channelId, limit = 10) {
  return discordFetch(`/channels/${channelId}/messages?limit=${limit}`);
}

async function sendMessage(channelId, content) {
  return discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: ["everyone"] },
    }),
  });
}

function hasRecentlyPostedSameMessage(messages) {
  const now = Date.now();

  return messages.some((msg) => {
    if (msg.content !== GOODNIGHT_MESSAGE) return false;
    if (!msg.author?.bot) return false;

    const ts = new Date(msg.timestamp).getTime();
    return now - ts <= DUPLICATE_WINDOW_MS;
  });
}

export default async () => {
  try {
    if (!BOT_TOKEN || !GUILD_ID || !TAVERNE_CHANNEL_ID) {
      return new Response(
        JSON.stringify({ ok: false, error: "Variables d'environnement manquantes" }),
        { status: 500 }
      );
    }

    const voiceStates = await getGuildVoiceStates();

    const targetState = Array.isArray(voiceStates)
      ? voiceStates.find((vs) => String(vs.user_id) === TARGET_USER_ID)
      : null;

    const isInVoice = !!targetState?.channel_id;

    if (isInVoice) {
      return new Response(
        JSON.stringify({
          ok: true,
          action: "none",
          reason: "target_still_in_voice",
          channel_id: targetState.channel_id,
        }),
        { status: 200 }
      );
    }

    const recentMessages = await getRecentMessages(TAVERNE_CHANNEL_ID, 10);

    if (hasRecentlyPostedSameMessage(recentMessages)) {
      return new Response(
        JSON.stringify({
          ok: true,
          action: "none",
          reason: "duplicate_prevented",
        }),
        { status: 200 }
      );
    }

    await sendMessage(TAVERNE_CHANNEL_ID, GOODNIGHT_MESSAGE);

    return new Response(
      JSON.stringify({
        ok: true,
        action: "message_sent",
      }),
      { status: 200 }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error.message,
      }),
      { status: 500 }
    );
  }
};

export const config = {
  schedule: "*/1 * * * *",
};