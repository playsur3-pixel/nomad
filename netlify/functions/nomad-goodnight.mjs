import { getStore } from "@netlify/blobs";

const DISCORD_API = "https://discord.com/api/v10";

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const TARGET_USER_ID = "319045529373900800"; // nomad31770
const TAVERNE_CHANNEL_ID = process.env.DISCORD_TAVERNE_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const GOODNIGHT_MESSAGE = "@everyone Bonne nuit tout le monde, à plus tard ! Bisous";

// Store persistant Netlify Blobs
const store = getStore({ name: "nomad-goodnight", consistency: "strong" });
const STATE_KEY = `voice-state-${TARGET_USER_ID}`;

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

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const err = new Error(`Discord API ${res.status}: ${text}`);
    err.status = res.status;
    err.data = data;
    console.log("Discord error body:", text);
    throw err;
  }

  return data;
}

async function getUserVoiceState() {
  try {
    return await discordFetch(`/guilds/${GUILD_ID}/voice-states/${TARGET_USER_ID}`);
  } catch (error) {
    // 404 Unknown Voice State = l'utilisateur n'est pas en vocal
    if (error.status === 404 && error.data?.code === 10065) {
      console.log("User is not in voice");
      return null;
    }
    throw error;
  }
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

async function readPreviousState() {
  const raw = await store.get(STATE_KEY, { type: "json", consistency: "strong" });
  if (!raw) {
    return { inVoice: null, lastSentAt: null };
  }
  return raw;
}

async function writeState(nextState) {
  await store.setJSON(STATE_KEY, nextState);
}

export default async () => {
  try {
    console.log("Function started");

    if (!BOT_TOKEN || !GUILD_ID || !TAVERNE_CHANNEL_ID) {
      console.log("Missing env vars");
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Variables d'environnement manquantes",
        }),
        { status: 500 }
      );
    }

    const previousState = await readPreviousState();
    console.log("Previous state:", JSON.stringify(previousState));

    const voiceState = await getUserVoiceState();
    const isInVoice = !!voiceState?.channel_id;

    console.log("Current voice state:", JSON.stringify(voiceState));
    console.log("Is in voice:", isInVoice);

    // Cas 1 : joueur actuellement en vocal
    if (isInVoice) {
      await writeState({
        inVoice: true,
        lastSeenChannelId: voiceState.channel_id,
        lastCheckedAt: new Date().toISOString(),
        lastSentAt: previousState.lastSentAt ?? null,
      });

      console.log("Result: target_still_in_voice");
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

    // Cas 2 : joueur hors vocal, mais il n'y était déjà pas au run précédent
    if (previousState.inVoice !== true) {
      await writeState({
        inVoice: false,
        lastSeenChannelId: previousState.lastSeenChannelId ?? null,
        lastCheckedAt: new Date().toISOString(),
        lastSentAt: previousState.lastSentAt ?? null,
      });

      console.log("Result: already_out_of_voice_no_send");
      return new Response(
        JSON.stringify({
          ok: true,
          action: "none",
          reason: "already_out_of_voice_no_send",
        }),
        { status: 200 }
      );
    }

    // Cas 3 : transition true -> false = il vient de quitter
    await sendMessage(TAVERNE_CHANNEL_ID, GOODNIGHT_MESSAGE);

    await writeState({
      inVoice: false,
      lastSeenChannelId: previousState.lastSeenChannelId ?? null,
      lastCheckedAt: new Date().toISOString(),
      lastSentAt: new Date().toISOString(),
    });

    console.log("Result: message_sent_once_after_leave");

    return new Response(
      JSON.stringify({
        ok: true,
        action: "message_sent",
        reason: "message_sent_once_after_leave",
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
  schedule: "*/5 * * * *",
};