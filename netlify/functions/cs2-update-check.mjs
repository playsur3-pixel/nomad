import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const STEAM_NEWS_API =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=12000&format=json";

function normalizeSteamText(input = "") {
  return String(input)
    .replace(/\r/g, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\\[/g, "[")
    .replace(/\\\]/g, "]")
    .replace(/\\\\/g, "\\")
    .trim();
}

function stripBBCode(input = "") {
  return normalizeSteamText(input)
    .replace(/\[\/?b\]/gi, "**")
    .replace(/\[\/?i\]/gi, "*")
    .replace(/\[h1\](.*?)\[\/h1\]/gis, "\n**$1**\n")
    .replace(/\[h2\](.*?)\[\/h2\]/gis, "\n**$1**\n")
    .replace(/\[h3\](.*?)\[\/h3\]/gis, "\n**$1**\n")
    .replace(/\[list\]/gi, "\n")
    .replace(/\[\/list\]/gi, "\n")
    .replace(/\[\*\]/g, "\n• ")
    .replace(/\[url=(.*?)\](.*?)\[\/url\]/gis, "$2 ($1)")
    .replace(/\[\/?url\]/gi, "")
    .replace(/\[img\].*?\[\/img\]/gis, "")
    .replace(/\[previewyoutube=.*?\].*?\[\/previewyoutube\]/gis, "")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatCs2PatchNotes(text = "") {
  let output = text.trim();

  output = output
    .replace(/^\s*\\?\[\s*(.*?)\s*\]\s*$/gm, "\n**[ $1 ]**")
    .replace(/\\(?=[A-Z])/g, "\n• ")
    .replace(/([a-z0-9.,;:!?")\]])\.([A-Z])/g, "$1.\n• $2")
    .replace(/([^\n])• /g, "$1\n• ")
    .replace(/\n\s*•\s*/g, "\n• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return output;
}

function truncateDiscord(text, max = 3500) {
  if (!text) return "";
  if (text.length <= max) return text;

  return `${text.slice(0, max - 40).trim()}\n\n...`;
}

function formatDate(unixSeconds) {
  if (!unixSeconds) return "Non précisée";

  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  }).format(new Date(unixSeconds * 1000));
}

function getBlobStore() {
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_AUTH_TOKEN) {
    throw new Error("Variables NETLIFY_SITE_ID ou NETLIFY_AUTH_TOKEN absentes.");
  }

  return getStore({
    name: "cs2-update-watcher",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN,
  });
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

  const cleanedContents = formatCs2PatchNotes(stripBBCode(update.contents || ""));

  return {
    id: String(update.gid || update.date || update.title),
    title: update.title || "Counter-Strike 2 Update",
    url: update.url || "https://www.counter-strike.net/news/updates",
    date: update.date,
    contents: cleanedContents,
  };
}

async function postToDiscord(update) {
  const webhookUrl = process.env.DISCORD_CS2_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error("Variable DISCORD_CS2_WEBHOOK_URL absente.");
  }

  const payload = {
    embeds: [
      {
        title: update.title,
        url: update.url,
        color: 0xf5a623,
        description: truncateDiscord(update.contents, 3500),
        fields: [
          {
            name: "Date",
            value: formatDate(update.date),
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
  const store = getBlobStore();

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

async function handler(event) {
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

const scheduledHandler = schedule("*/15 * * * *", handler);

export { scheduledHandler as handler };
