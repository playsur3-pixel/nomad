import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const STEAM_NEWS_API =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=20000&format=json";

const DISCORD_EMBED_FIELD_LIMIT = 1024;
const DISCORD_MAX_FIELDS = 25;

function decodeHtmlEntities(text = "") {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeSpaces(text = "") {
  return String(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractReadableHtml(html = "") {
  const candidates = [
    /<div[^>]*class=["'][^"']*announcement_body[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["'][^"']*bodytext[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["'][^"']*event_details[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class=["'][^"']*partnereventdisplay_EventDetailsBody[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }

  return html;
}

function htmlToPatchText(html = "") {
  let text = extractReadableHtml(html);

  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/div>/gi, "\n")
    .replace(/<div[^>]*>/gi, "")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n")
    .replace(/<ul[^>]*>/gi, "\n")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<ol[^>]*>/gi, "\n")
    .replace(/<\/ol>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]+>/g, "");

  return normalizeSpaces(decodeHtmlEntities(text));
}

function normalizeApiContents(input = "") {
  return String(input)
    .replace(/\r/g, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\\[/g, "[")
    .replace(/\\\]/g, "]")
    .replace(/\\\\/g, "\n\n")
    .replace(/\\(?=[A-Z])/g, "\n• ")
    .replace(/([a-z0-9.,;:!?")\]])\.([A-Z])/g, "$1.\n• $2")
    .replace(/([^\n])• /g, "$1\n• ")
    .replace(/\n\s*•\s*/g, "\n• ")
    .trim();
}

function cleanPatchText(text = "") {
  return normalizeSpaces(
    String(text)
      .replace(/^\s*[-*]\s+/gm, "• ")
      .replace(/^\s*•\s*/gm, "• ")
      .replace(/\[\s+/g, "[ ")
      .replace(/\s+\]/g, " ]")
      .replace(/\n\s*\[\s*(.*?)\s*\]\s*\n/g, "\n[ $1 ]\n")
  );
}

function parsePatchSections(text = "") {
  const cleaned = cleanPatchText(text);
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = [];
  let current = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^\[\s*(.*?)\s*\]$/);

    if (sectionMatch) {
      current = {
        title: `[ ${sectionMatch[1].trim().toUpperCase()} ]`,
        lines: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      current = {
        title: "Notes",
        lines: [],
      };
      sections.push(current);
    }

    current.lines.push(line.startsWith("•") ? line : `• ${line}`);
  }

  return sections.filter((section) => section.lines.length > 0);
}

function splitTextForDiscordField(text, limit = DISCORD_EMBED_FIELD_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= limit) {
      current = line;
      continue;
    }

    for (let i = 0; i < line.length; i += limit - 20) {
      chunks.push(`${line.slice(i, i + limit - 20)}...`);
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

function buildPatchFields(sections) {
  const fields = [];

  for (const section of sections) {
    const value = section.lines.join("\n");
    const chunks = splitTextForDiscordField(value);

    for (let index = 0; index < chunks.length; index++) {
      if (fields.length >= DISCORD_MAX_FIELDS - 2) break;

      fields.push({
        name: index === 0 ? section.title : `${section.title} suite`,
        value: chunks[index],
        inline: false,
      });
    }
  }

  return fields;
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

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "REFACTO-CS2-Update-Watcher/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`HTML update fetch HTTP ${response.status}`);
  }

  return response.text();
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

  let patchText = "";

  try {
    const html = await fetchText(update.url);
    patchText = htmlToPatchText(html);
  } catch (error) {
    console.warn(`Fallback API contents utilisé : ${error.message}`);
    patchText = normalizeApiContents(update.contents || "");
  }

  const sections = parsePatchSections(patchText);

  if (!sections.length) {
    const fallbackText = normalizeApiContents(update.contents || "");
    return {
      id: String(update.gid || update.date || update.title),
      title: update.title || "Counter-Strike 2 Update",
      url: update.url || "https://www.counter-strike.net/news/updates",
      date: update.date,
      sections: parsePatchSections(fallbackText),
    };
  }

  return {
    id: String(update.gid || update.date || update.title),
    title: update.title || "Counter-Strike 2 Update",
    url: update.url || "https://www.counter-strike.net/news/updates",
    date: update.date,
    sections,
  };
}

function buildDiscordPayload(update) {
  const fields = buildPatchFields(update.sections);

  fields.push(
    {
      name: "Date",
      value: formatDate(update.date),
      inline: true,
    },
    {
      name: "Source",
      value: "Steam / Valve",
      inline: true,
    }
  );

  return {
    embeds: [
      {
        title: update.title,
        url: update.url,
        color: 0xf5a623,
        thumbnail: {
          url: "https://cdn.cloudflare.steamstatic.com/apps/csgo/images/csgo_react/social/cs2.jpg",
        },
        fields,
        footer: {
          text: "Auto-post CS2 updates",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function postToDiscord(update) {
  const webhookUrl = process.env.DISCORD_CS2_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error("Variable DISCORD_CS2_WEBHOOK_URL absente.");
  }

  const payload = buildDiscordPayload(update);

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
