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
    console.log("Non-JSON response:", text);
    return text;
  }
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
    console.log("Function started");

    if (!BOT_TOKEN || !GUILD_ID || !TAVERNE_CHANNEL_ID) {
      console.log("Missing env vars");
      return new Response(
        JSON.stringify({ ok: false, error: "Variables d'environnement manquantes" }),
        { status: 500 }
      );
    }

    console.log("Env vars OK");
    console.log("Guild ID:", GUILD_ID);
    console.log("Target user:", TARGET_USER_ID);
    console.log("Taverne channel:", TAVERNE_CHANNEL_ID);

    const voiceStates = await getGuildVoiceStates();
    console.log("Voice states response:", JSON.stringify(voiceStates));

    const targetState = Array.isArray(voiceStates)
      ? voiceStates.find((vs) => String(vs.user_id) === TARGET_USER_ID)
      : null;

    console.log("Target state:", JSON.stringify(targetState));

    const isInVoice = !!targetState?.channel_id;
    console.log("Is in voice:", isInVoice);

    if (isInVoice) {
      console.log("Result: target_still_in_voice");
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
    console.log("Recent messages fetched:", Array.isArray(recentMessages) ? recentMessages.length : "not-array");

    if (hasRecentlyPostedSameMessage(recentMessages)) {
      console.log("Result: duplicate_prevented");
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
    console.log("Result: message_sent");

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