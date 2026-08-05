// scripts/update-surf-safety.mjs
// Calls the Claude API (with web search enabled) once a day to check today's
// beach warning flag status and rip current risk for the Grayton Beach / South
// Walton (30A) coast, and writes it into conditions.json.
//
// There's no free structured API for beach flag color (it's set by lifeguards
// twice a day and posted to a fire-district website, not a data feed), and no
// clean JSON field for rip current risk either — this genuinely needs a model
// reading a page and a text forecast product, same reasoning as why
// update-bite-report.mjs in the sibling 331 Bridge app needs Claude rather
// than a plain fetch. This is the one script with no direct bay-app analog:
// a bay has no surf, so it never needed a safety-flag concept at all.

import { readFile, writeFile } from "fs/promises";

const OUT_PATH = new URL("../src/data/conditions.json", import.meta.url);
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — skipping beach safety update (non-fatal).");
  process.exit(0);
}

function buildPrompt() {
  return `Search for TODAY's beach warning flag color and rip current risk for the South Walton / 30A coast (Dune Allen Beach, Blue Mountain Beach, Grayton Beach, Seagrove Beach, and Inlet Beach, FL — all Walton County), and for the wider Okaloosa/Walton/Bay County Florida panhandle Gulf coast.

The flag system is set and posted county-wide by the South Walton Fire District (SWFD) — it is the same flag for every beach in Walton County on a given day, not set per individual beach. So you do NOT need independent confirmation from every single beach access point — a reading from any one Walton County source is enough, AS LONG AS it is genuinely from today. Do not hedge or mark it unconfirmed merely because it only came from one beach instead of all five.

That said, currency (is this actually today's flag?) is a separate requirement from coverage (does it need to come from every beach?), and currency is not negotiable. A source that is more than 1-2 days old — a "last refreshed" widget from a week ago, a cached feed, a stale aggregator page — is NOT today's flag status, full stop, no matter how confidently it's presented. If every source you can find is stale like that, do not report its color as the answer with the staleness buried as a caveat in "notes" — set "flagColor" and "ripCurrentRisk" to "unknown" instead, and explain in "notes" that no genuinely current reading was found. A confidently-stated wrong answer is worse than an honest "unknown" here.

If available, Surfline's latest surf report for Grayton Beach (or the nearest 30A surf spot) should be preferred for surf height/wave detail. If you (the caller) supply a short Surfline summary string, include it in your reasoning and prefer its surf-height detail where it is clearly current. Also check the South Walton Fire District's surf conditions page (swfd.org/beach-safety/surf-conditions) for today's posted flag color, and the NWS Surf Zone Forecast for the Florida panhandle coast (issued by NWS Tallahassee, forecast.weather.gov) for today's rip current risk category and surf height range.

If Surfline is available and current, prefer its wave detail; if Surfline is unavailable, rely on NWS and the local fire district page. The flag system is: green (low hazard), yellow (medium hazard, moderate surf/currents), red (high hazard, strong surf/currents), double red (water closed to the public). A purple flag flying alongside another color means dangerous marine life reported (jellyfish, stingrays, etc) — include that only if it's actually flying today.

Respond with ONLY a JSON object, no other text, no markdown fences:
{"flagColor": "green|yellow|red|double red|unknown", "ripCurrentRisk": "low|moderate|high|unknown", "surfHeight": "e.g. 1-2 ft", "purpleFlag": false, "notes": "1-2 sentence practical note for someone deciding whether to surf fish today", "source": "brief attribution, e.g. site names you drew from"}`;
}

async function fetchSurfline() {
  // Try a couple of simple Surfline URL patterns and look for a numeric
  // surf height. This is best-effort: Surfline pages can be JS-heavy, so
  // we perform a lightweight text scrape and regex extraction.
  const candidates = [
    'https://www.surfline.com/surf-report/grayton-beach',
    'https://www.surfline.com/surf-report/grayton-beach-fl/5842041f4e65fad6a77088d4'
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) continue;
      const text = await res.text();
      // Prefer explicit "ft" ranges like "1-2 ft" or "2 ft" or the word "Flat"
      const rangeMatch = text.match(/(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*ft)/i);
      const singleMatch = text.match(/(\d+(?:\.\d+)?\s*ft)/i);
      const flatMatch = text.match(/\bflat\b/i);
      if (rangeMatch) return { surfline: rangeMatch[1].replace(/\s+/g, ' '), source: url };
      if (singleMatch) return { surfline: singleMatch[1].replace(/\s+/g, ' '), source: url };
      if (flatMatch) return { surfline: 'Flat', source: url };
    } catch (e) {
      // ignore and try next
    }
  }
  return null;
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

  let result;
  try {
    result = await callClaude(buildPrompt());
  } catch (err) {
    console.error("Beach safety update failed, leaving previous value in place:", err.message);
    process.exit(0);
  }

  if (!result.flagColor) {
    console.error("Unexpected response shape, leaving previous value in place.");
    process.exit(0);
  }

  const updated = {
    ...existing,
    shared: {
      ...existing.shared,
      beachFlag: {
        color: result.flagColor,
        ripCurrentRisk: result.ripCurrentRisk,
        surfHeight: result.surfHeight,
        purpleFlag: !!result.purpleFlag,
        notes: result.notes,
        source: `${result.source} · Auto-refreshed via Claude API`,
        updated: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }),
      },
    },
  };

  await writeFile(OUT_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log("Beach safety updated:", updated.shared.beachFlag.color, "·", updated.shared.beachFlag.ripCurrentRisk, "rip risk");
}

main();
