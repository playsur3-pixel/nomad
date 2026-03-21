const DISCORD_API = "https://discord.com/api/v10";

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TARGET_USER_ID = "319045529373900800";
const TAVERNE_CHANNEL_ID = process.env.DISCORD_TAVERNE_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const GOODNIGHT_MESSAGE = "@everyone Bonne nuit tout le monde, à plus tard ! Bisous";
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

async function discordFetch(path, options = {}) {
  const url = `${DISCORD_API}${path}`;
  console.log("Discord fetch:", options.method || "GET", url);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  console.log("Discord status:", res.status);

  if (!res.ok) {
    console.log("Discord error body:", text);
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getUserVoiceState() {
  return discordFetch(`/guilds/${GUILD_ID}/voice-states/${TARGET_USER_ID}`);
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
    console.log("Function started");

    if (!BOT_TOKEN || !GUILD_ID || !TAVERNE_CHANNEL_ID) {
      return new Response(
        JSON.stringify({ ok: false, error: "Variables d'environnement manquantes" }),
        { status: 500 }
      );
    }

    const voiceState = await getUserVoiceState();
    console.log("Voice state:", JSON.stringify(voiceState));

    const isInVoice = !!voiceState?.channel_id;
    console.log("Is in voice:", isInVoice);

    if (isInVoice) {
      return new Response(
        JSON.stringify({
          ok: true,
          action: "none",
          reason: "target_still_in_voice",
          channel_id: voiceState.channel_id,
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
    console.error("Function error:", error);

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