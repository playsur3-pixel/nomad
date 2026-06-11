import { schedule } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const STEAM_NEWS_API =
  "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=20000&format=json";

const DISCORD_FIELD_SAFE_LIMIT = 900;
const DISCORD_MAX_FIELDS_PER_EMBED = 23; // 25 max Discord, on garde Date + Source séparés
const DISCORD_MAX_EMBEDS_PER_MESSAGE = 10;

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

function extractMetaContent(html = "", property = "") {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const hasWantedProperty =
      new RegExp(`\\bproperty=(["'])${escapedProperty}\\1`, "i").test(tag) ||
      new RegExp(`\\bname=(["'])${escapedProperty}\\1`, "i").test(tag);

    if (!hasWantedProperty) continue;

    const contentMatch = tag.match(/\bcontent=(["'])([\s\S]*?)\1/i);

    if (contentMatch?.[2]) {
      return decodeHtmlEntities(contentMatch[2]);
    }
  }

  return "";
}

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }

  return "";
}

function htmlToPatchText(html = "") {
  const description =
    extractMetaContent(html, "og:description") ||
    extractMetaContent(html, "description") ||
    "";

  return normalizeSpaces(description);
}

function normalizeApiContents(input = "") {
  const raw = String(input)
    .replace(/\r/g, "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .trim();

  // Cas connu : l'API Steam renvoie cette update sans titres de sections.
  if (
    raw.includes("Cologne 2026 Major Shop") &&
    raw.includes("Storage Units deposit/retrieve UI")
  ) {
    return `[ COLOGNE 2026 ]

• Added display of lowest and highest sticker price in the last 7 days in the Cologne 2026 Major Shop.
• Added stickers showcase to the Cologne 2026 Major Hub tile on the main menu.

[ MISC ]

• Added multi-select functionality in Storage Units deposit/retrieve UI.
• Added appropriate error message when user's inventory is full and they try to redeem Weekly Care Package rewards, Armory items, or items in the Major Shop cart.
• Fixed number wrapping rules in some languages.`;
  }

  return raw
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

function splitLongLineAtSentence(line, limit = DISCORD_FIELD_SAFE_LIMIT) {
  if (line.length <= limit) return [line];

  const chunks = [];
  let remaining = line;

  while (remaining.length > limit) {
    let splitIndex = remaining.lastIndexOf(". ", limit);

    if (splitIndex < 100) {
      splitIndex = remaining.lastIndexOf("; ", limit);
    }

    if (splitIndex < 100) {
      splitIndex = remaining.lastIndexOf(", ", limit);
    }

    if (splitIndex < 100) {
      splitIndex = remaining.lastIndexOf(" ", limit);
    }

    if (splitIndex < 100) {
      splitIndex = limit;
    }

    const chunk = remaining.slice(0, splitIndex + 1).trim();
    chunks.push(chunk);

    remaining = remaining.slice(splitIndex + 1).trim();

    if (remaining && !remaining.startsWith("•")) {
      remaining = `• ${remaining}`;
    }
  }

  if (remaining) chunks.push(remaining);

  return chunks;
}

function splitLinesIntoSafeChunks(lines, limit = DISCORD_FIELD_SAFE_LIMIT) {
  const chunks = [];
  let current = "";

  const safeLines = lines.flatMap((line) => splitLongLineAtSentence(line, limit));

  for (const line of safeLines) {
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    current = line;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function buildPatchFields(sections) {
  const fields = [];

  for (const section of sections) {
    const chunks = splitLinesIntoSafeChunks(section.lines, DISCORD_FIELD_SAFE_LIMIT);

    chunks.forEach((chunk, index) => {
      fields.push({
        name: index === 0 ? section.title : `${section.title} suite`,
        value: chunk,
        inline: false,
      });
    });
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
  }

  // Sécurité : ne jamais poster le menu Steam / footer / page complète.
 const apiPatchText = normalizeApiContents(update.contents || "");

if (
  !patchText ||
  patchText.includes("Sign in") ||
  patchText.includes("Change language") ||
  patchText.includes("Valve Corporation") ||
  patchText.includes("Steam Subscriber Agreement") ||
  patchText.length < 50 ||
  apiPatchText.length > patchText.length + 80
) {
  patchText = apiPatchText;
}

  let sections = parsePatchSections(patchText);

  if (!sections.length) {
    sections = parsePatchSections(normalizeApiContents(update.contents || ""));
  }

  return {
    id: String(update.gid || update.date || update.title),
    title: update.title || "Counter-Strike 2 Update",
    url: update.url || "https://www.counter-strike.net/news/updates",
    date: update.date,
    sections,
  };
}

function chunkFieldsIntoEmbeds(update) {
  const patchFields = buildPatchFields(update.sections);
  const embeds = [];

  for (let i = 0; i < patchFields.length; i += DISCORD_MAX_FIELDS_PER_EMBED) {
    const fieldChunk = patchFields.slice(i, i + DISCORD_MAX_FIELDS_PER_EMBED);
    const partIndex = embeds.length + 1;

    embeds.push({
      title:
        partIndex === 1
          ? update.title
          : `${update.title} — suite ${partIndex}`,
      url: update.url,
      color: 0xf5a623,
      thumbnail:
        partIndex === 1
          ? {
              url: "https://cdn.cloudflare.steamstatic.com/apps/csgo/images/csgo_react/social/cs2.jpg",
            }
          : undefined,
      fields: fieldChunk,
      footer: {
        text: "Auto-post CS2 updates",
      },
      timestamp: new Date().toISOString(),
    });
  }

  if (!embeds.length) {
    embeds.push({
      title: update.title,
      url: update.url,
      color: 0xf5a623,
      description: "Aucune note lisible trouvée.",
      footer: {
        text: "Auto-post CS2 updates",
      },
      timestamp: new Date().toISOString(),
    });
  }

  const lastEmbed = embeds[embeds.length - 1];

  lastEmbed.fields = [
    ...(lastEmbed.fields || []),
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
  ];

  return embeds;
}

function buildDiscordMessages(update) {
  const embeds = chunkFieldsIntoEmbeds(update);
  const messages = [];

  for (let i = 0; i < embeds.length; i += DISCORD_MAX_EMBEDS_PER_MESSAGE) {
    messages.push({
      embeds: embeds.slice(i, i + DISCORD_MAX_EMBEDS_PER_MESSAGE),
    });
  }

  return messages;
}

async function postToDiscord(update) {
  const webhookUrl = process.env.DISCORD_CS2_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error("Variable DISCORD_CS2_WEBHOOK_URL absente.");
  }

  const messages = buildDiscordMessages(update);

  for (const payload of messages) {
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
