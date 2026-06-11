import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const STEAM_NEWS_API =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=12000&format=json";

function stripBBCode(input = "") {
  return input
    .replace(/\r/g, "")
    .replace(/\[\/?b\]/gi, "**")
    .replace(/\[\/?i\]/gi, "*")
    .replace(/\[h1\](.*?)\[\/h1\]/gis, "**$1**\n")
    .replace(/\[h2\](.*?)\[\/h2\]/gis, "**$1**\n")
    .replace(/\[h3\](.*?)\[\/h3\]/gis, "**$1**\n")
    .replace(/\[list\]/gi, "")
    .replace(/\[\/list\]/gi, "")
    .replace(/\[\*\]/g, "• ")
    .replace(/\[url=(.*?)\](.*?)\[\/url\]/gis, "$2 ($1)")
    .replace(/\[\/?url\]/gi, "")
    .replace(/\[img\].*?\[\/img\]/gis, "")
    .replace(/\[previewyoutube=.*?\].*?\[\/previewyoutube\]/gis, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateDiscord(text, max = 3500) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max - 20).trim()}\n\n...`;
}

function formatDate(unixSeconds) {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  }).format(new Date(unixSeconds * 1000));
}

async function fetchLatestCs2Update() {
  const response = await fetch(STEAM_NEWS_API, {
    headers: {
      "User-Agent": "REFACTO-CS2-Update-Watcher/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Steam News API HTTP ${response.status}`);
  }

  const data = await response.json();
  const items = data?.appnews?.newsitems ?? [];

  const update = items.find((item) =>
    String(item.title || "").toLowerCase().includes("counter-strike 2 update")
  );

  if (!update) {
    throw new Error("Aucune news Counter-Strike 2 Update trouvée.");
  }

  return {
    id: String(update.gid || update.date || update.title),
    title: update.title || "Counter-Strike 2 Update",
    url: update.url || "https://www.counter-strike.net/news/updates",
    date: update.date,
    contents: stripBBCode(update.contents || ""),
  };
}

async function postToDiscord(update) {
  const webhookUrl = process.env.DISCORD_CS2_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error("Variable DISCORD_CS2_WEBHOOK_URL absente.");
  }

  const payload = {
    username: "CS2 Update",
    avatar_url:
      "https://cdn.cloudflare.steamstatic.com/apps/csgo/images/csgo_react/social/cs2.jpg",
    embeds: [
      {
        title: update.title,
        url: update.url,
        color: 0xf5a623,
        description: truncateDiscord(update.contents, 3500),
        fields: [
          {
            name: "Date",
            value: update.date ? formatDate(update.date) : "Non précisée",
            inline: true,
          },
          {
            name: "Source",
            value: "Steam / Valve",
            inline: true,
          },
        ],
        footer: {
          text: "Auto-post CS2 updates",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook HTTP ${response.status}: ${text}`);
  }
}

async function runCheck({ force = false } = {}) {
  const store = getStore("cs2-update-watcher");

  const latest = await fetchLatestCs2Update();
  const lastPostedId = await store.get("last-posted-id", { type: "text" });

  if (!force && lastPostedId === latest.id) {
    return {
      status: "noop",
      message: `Déjà posté : ${latest.title}`,
      id: latest.id,
    };
  }

  await postToDiscord(latest);
  await store.set("last-posted-id", latest.id);

  return {
    status: "posted",
    message: `Update postée : ${latest.title}`,
    id: latest.id,
  };
}

async function manualHandler(event) {
  try {
    const force = event.queryStringParameters?.force === "1";
    const result = await runCheck({ force });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result, null, 2),
    };
  } catch (error) {
    console.error(error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        {
          status: "error",
          message: error.message,
        },
        null,
        2
      ),
    };
  }
}

const scheduledHandler = schedule("*/15 * * * *", manualHandler);

export { scheduledHandler as handler };
