// scripts/update-surf-safety.mjs
// Determines today's beach warning flag status and rip current risk for the
// South Walton / 30A coast and writes it into conditions.json.
//
// Flag color + purple (marine pest) flag: fetched directly from
// visitsouthwalton.com/beach-safety/, South Walton's official visitor site.
// Its flag widget is plain server-rendered HTML — the color is right there
// in an <img alt="..."> — updated by SWFD, no JS execution or LLM guessing
// needed. This is ground truth, not a best-effort scrape: prefer it over
// anything Claude might find via search, which was liable to surface a
// stale cached copy from some third-party aggregator instead.
//
// Rip current risk + surf height + a practical note: still need Claude
// (with web search) reading the NWS Surf Zone Forecast text product — there's
// no clean structured API for that, same reasoning as why
// update-bite-report.mjs in the sibling 331 Bridge app needs Claude rather
// than a plain fetch.

import { readFile, writeFile } from "fs/promises";

const OUT_PATH = new URL("../src/data/conditions.json", import.meta.url);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const USER_AGENT = "30a-surf-report (github.com/djblackjr/30a-surf-report)";

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — skipping beach safety update (non-fatal).");
  process.exit(0);
}

// Ground-truth flag color + marine-pest (purple) flag, scraped directly from
// the official South Walton visitor site. Throws if the site's unreachable
// or its markup has changed shape — callers fall back to Claude search.
async function fetchOfficialFlag() {
  const url = "https://www.visitsouthwalton.com/beach-safety/";
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const html = await res.text();

  const idx = html.indexOf('class="flagWrapper"');
  if (idx === -1) throw new Error("flagWrapper widget not found — site layout may have changed");
  const block = html.slice(idx, idx + 800);

  const altMatch = block.match(/<img alt="((?:Double Red|Green|Yellow|Red)[^"]*)"/i);
  if (!altMatch) throw new Error(`Could not find a flag <img alt="..."> in the widget: ${block.slice(0, 200)}`);
  const colorMatch = altMatch[1].match(/double red|green|yellow|red/i);
  if (!colorMatch) throw new Error(`Could not parse a flag color out of: "${altMatch[1]}"`);

  return {
    color: colorMatch[0].toLowerCase(),
    purpleFlag: /Marine Pests Flag/i.test(block),
    source: url,
  };
}

// Rip current risk / surf height / notes only — flag color and purple flag
// are already known ground truth by the time this runs, so Claude doesn't
// need to (and shouldn't try to) re-derive or second-guess them.
function buildRiskPrompt(officialFlag) {
  return `Today's official South Walton beach flag (from visitsouthwalton.com, South Walton's visitor site — already confirmed, do not second-guess it) is: ${officialFlag.color}${officialFlag.purpleFlag ? " with a purple (marine pest / jellyfish) flag also flying" : ""}.

Search for TODAY's rip current risk category and surf height range for the South Walton / 30A coast (Walton County, FL — Dune Allen Beach, Blue Mountain Beach, Grayton Beach, Seagrove Beach, Inlet Beach), from the NWS Surf Zone Forecast (issued by NWS Tallahassee, forecast.weather.gov) and, if available and clearly current, Surfline's latest surf report for Grayton Beach or the nearest 30A spot for surf-height detail.

Currency matters: a source more than 1-2 days old is not today's reading. If you can't find a genuinely current rip current risk or surf height, set that field to "unknown" rather than presenting stale data as current — an honest "unknown" beats a confidently wrong number.

Respond with ONLY a JSON object, no other text, no markdown fences:
{"ripCurrentRisk": "low|moderate|high|unknown", "surfHeight": "e.g. 1-2 ft", "notes": "1-2 sentence practical note for someone deciding whether to surf fish today", "source": "brief attribution, e.g. site names you drew from"}`;
}

// Fallback prompt used only if the official-site scrape itself fails (site
// down, markup changed) — asks Claude to find everything via search,
// including the flag color, same as before this direct-fetch was added.
function buildFullFallbackPrompt() {
  return `visitsouthwalton.com (South Walton's official visitor site, normally the authoritative flag source) could not be reached, so search for TODAY's beach warning flag color and rip current risk for the South Walton / 30A coast (Walton County, FL — Dune Allen Beach, Blue Mountain Beach, Grayton Beach, Seagrove Beach, Inlet Beach) some other way — check the South Walton Fire District's page (swfd.org/beach-safety/surf-conditions) and the NWS Surf Zone Forecast (forecast.weather.gov, issued by NWS Tallahassee) for today's posted flag color and rip current risk category, and Surfline's latest Grayton Beach report if available for surf height.

The flag is set county-wide by SWFD — the same flag flies at every Walton County beach on a given day, so a reading from any one source is enough; you do not need independent confirmation from every beach. But currency is non-negotiable regardless of source count: a "last refreshed" widget from days ago, a cached feed, or a stale aggregator page is NOT today's flag. If everything you find is stale, set "flagColor" and "ripCurrentRisk" to "unknown" and say so honestly in "notes" — a confidently-stated wrong answer is worse than an honest "unknown".

The flag system is: green (low hazard), yellow (medium hazard, moderate surf/currents), red (high hazard, strong surf/currents), double red (water closed to the public). A purple flag flying alongside another color means dangerous marine life reported (jellyfish, stingrays, etc) — include that only if it's actually flying today.

Respond with ONLY a JSON object, no other text, no markdown fences:
{"flagColor": "green|yellow|red|double red|unknown", "ripCurrentRisk": "low|moderate|high|unknown", "surfHeight": "e.g. 1-2 ft", "purpleFlag": false, "notes": "1-2 sentence practical note for someone deciding whether to surf fish today", "source": "brief attribution, e.g. site names you drew from"}`;
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const textBlocks = data.content.filter((b) => b.type === "text").map((b) => b.text);
  const raw = textBlocks.join("\n").trim();
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
}

async function main() {
  const existing = JSON.parse(await readFile(OUT_PATH, "utf-8"));

  // One flag status covers the whole South Walton / 30A coast (SWFD is a
  // single fire district for the corridor), so this writes into `shared`
  // rather than per-location. update-conditions.mjs always runs first in
  // the daily pipeline and performs the flat-shape migration, so
  // existing.shared is expected to exist by the time this runs.
  if (!existing.shared) {
    console.error("conditions.json is missing `shared` — run update-conditions.mjs first. Skipping (non-fatal).");
    process.exit(0);
  }

  const officialFlag = await fetchOfficialFlag().catch((err) => {
    console.warn("Official flag scrape failed, falling back to Claude search for the flag itself too:", err.message);
    return null;
  });

  let result;
  try {
    result = await callClaude(officialFlag ? buildRiskPrompt(officialFlag) : buildFullFallbackPrompt());
  } catch (err) {
    console.error("Beach safety update failed, leaving previous value in place:", err.message);
    process.exit(0);
  }

  const flagColor = officialFlag?.color ?? result.flagColor;
  const purpleFlag = officialFlag ? officialFlag.purpleFlag : !!result.purpleFlag;
  if (!flagColor) {
    console.error("Unexpected response shape, leaving previous value in place.");
    process.exit(0);
  }

  const source = officialFlag
    ? `visitsouthwalton.com/beach-safety (official flag) + ${result.source} (rip risk/surf height) · Auto-refreshed`
    : `${result.source} · Auto-refreshed via Claude API`;

  const updated = {
    ...existing,
    shared: {
      ...existing.shared,
      beachFlag: {
        color: flagColor,
        ripCurrentRisk: result.ripCurrentRisk,
        surfHeight: result.surfHeight,
        purpleFlag,
        notes: result.notes,
        source,
        updated: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }),
      },
    },
  };

  await writeFile(OUT_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log("Beach safety updated:", updated.shared.beachFlag.color, "·", updated.shared.beachFlag.ripCurrentRisk, "rip risk");
}

main();
