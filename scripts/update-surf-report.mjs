// Pulls the newest Northwest Florida Fishing Report podcast episode from its
// public RSS feed and writes its title, date, link and the publisher's own
// episode notes into conditions.json. No LLM and no API key: this replaced a
// Claude + web-search step to eliminate API charges.
//
// Sources that can't be read deterministically (Reel30A's Facebook/Instagram
// need a login; Half Hitch's blog is behind Cloudflare bot protection) are
// shown in the app as plain links instead.

import { readFile, writeFile } from "fs/promises";

const OUT_PATH = new URL("../src/data/conditions.json", import.meta.url);
const USER_AGENT = "30a-surf-report (github.com/djblackjr/30a-surf-report)";
const FEED_URL = "https://northwestfloridafishingreport.libsyn.com/rss";
const SOURCE_NAME = "Northwest Florida Fishing Report";
const MAX_AGE_DAYS = 14;
const MAX_NOTES_CHARS = 420;
const DAY_MS = 86_400_000;
const SURF_TERMS = /\b(surf|pompano|beach|30A|South Walton|whiting|sand flea)/i;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

// Trim to whole sentences so the excerpt never ends mid-word.
function excerpt(text) {
  if (text.length <= MAX_NOTES_CHARS) return text;
  const cut = text.slice(0, MAX_NOTES_CHARS);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastStop > 80 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

async function fetchLatestEpisode() {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml,application/xml" } });
  if (!res.ok) throw new Error(`${FEED_URL} -> ${res.status}`);
  const xml = await res.text();
  const episodes = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
    const published = new Date(tagText(item, "pubDate"));
    let url = null;
    try { url = new URL(tagText(item, "link")); } catch {}
    return {
      title: tagText(item, "title"),
      notes: tagText(item, "description"),
      published,
      url: url?.protocol === "https:" ? url.href : null,
    };
  }).filter((e) => e.title && !Number.isNaN(e.published.getTime()));
  if (!episodes.length) throw new Error("No episodes parsed from feed — format may have changed");
  return episodes.sort((a, b) => b.published - a.published)[0];
}

function chicagoDateISO(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(date);
}

function unavailableFields(refreshedAt) {
  return {
    surfBiteStatus: "unavailable",
    surfBiteReport: `No ${SOURCE_NAME} episode in the last ${MAX_AGE_DAYS} days. Check the local sources below.`,
    surfBiteHeadline: null,
    surfBiteSource: null,
    surfBiteSourceUrl: null,
    surfBiteSourceDate: null,
    surfBiteSourceKind: null,
    surfBiteMentionsSurf: false,
    surfBiteRefreshedAt: refreshedAt,
  };
}

async function main() {
  const existing = JSON.parse(await readFile(OUT_PATH, "utf-8"));
  if (!existing.shared) throw new Error("conditions.json is missing `shared`; run update-conditions.mjs first");

  const refreshedAt = new Date().toISOString();
  let episode;
  try {
    episode = await fetchLatestEpisode();
  } catch (err) {
    console.error("Fishing report feed fetch failed, leaving previous value in place:", err.message);
    process.exit(0);
  }

  const ageDays = (Date.now() - episode.published.getTime()) / DAY_MS;
  const current = ageDays >= -1 && ageDays <= MAX_AGE_DAYS;
  const fields = current ? {
    surfBiteStatus: "current",
    surfBiteReport: excerpt(episode.notes) || null,
    surfBiteHeadline: episode.title,
    surfBiteSource: SOURCE_NAME,
    surfBiteSourceUrl: episode.url,
    surfBiteSourceDate: chicagoDateISO(episode.published),
    surfBiteSourceKind: "podcast",
    surfBiteMentionsSurf: SURF_TERMS.test(`${episode.title} ${episode.notes}`),
    surfBiteRefreshedAt: refreshedAt,
  } : unavailableFields(refreshedAt);

  const updated = { ...existing, shared: { ...existing.shared, ...fields } };
  delete updated.shared.surfBiteUpdated;
  await writeFile(OUT_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log(current
    ? `Fishing report: "${episode.title}" (${fields.surfBiteSourceDate})${fields.surfBiteMentionsSurf ? " · mentions surf" : ""}`
    : `Latest episode is ${Math.round(ageDays)} days old; published an explicit unavailable state`);
}

main().catch((err) => {
  console.error("Fishing report update failed, leaving conditions.json untouched:", err.message);
  process.exit(1);
});
