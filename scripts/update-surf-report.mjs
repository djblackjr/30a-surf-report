// scripts/update-surf-report.mjs
// Calls the Claude API (with web search enabled) once a day to research
// current surf fishing reports for the 30A / Panama City Beach corridor and
// write a fresh summary into conditions.json. Same reasoning as the sibling
// 331 Bridge app's update-bite-report.mjs: there's no structured API for
// "current fishing chatter," so this needs a model reading and synthesizing
// real text, not a plain JSON fetch.

import { readFile, writeFile } from "fs/promises";

const OUT_PATH = new URL("../src/data/conditions.json", import.meta.url);
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — skipping surf report update (non-fatal).");
  process.exit(0);
}

function buildPrompt(waterTemp) {
  return `Search for current surf fishing reports (this week if possible) for the Florida panhandle Gulf-front coast between Sandestin/30A and Panama City Beach — Grayton Beach, Seaside, WaterColor, Inlet Beach, and Panama City Beach specifically. Focus on surf-zone species: pompano, whiting, redfish, bluefish, sheepshead, Spanish mackerel — not offshore/pier-only species like red snapper or grouper unless there's genuinely nothing else current.

Check these sources for current reports:
- halfhitch.com's Panama City Beach fishing report series (halfhitch.com/blog/pcb-fishing-report-*) — a local tackle shop that posts roughly weekly, dated reports
- noeoutdoors.com/pcb — an inshore/surf/pier report page for Panama City Beach
- hightidecharters30a.com — a 30A-specific charter with its own fishing report archive

Only use a source if it actually has a current post (this week or last) that you can genuinely read. If a given source's most recent content is old or you can't access/find one, silently skip it — do not mention that source, or the fact that you checked/omitted it, anywhere in your response. Only reference a source in surfBiteReport or surfBiteSource if it actually contributed content to the summary.

Write a short (3-5 sentence) summary in your own words — paraphrase everything, never quote any source directly, even in quotation marks. If the most recent available reports are more than a week old, say so plainly rather than presenting stale info as brand new.
${waterTemp ? `\nIf you mention water temperature, use ${waterTemp}°F — a same-day measured reading for this exact spot — rather than whatever approximate figure turns up in search results, which is often paraphrased from a days-old blog post.` : ""}
Respond with ONLY a JSON object, no other text, no markdown fences:
{"surfBiteReport": "your summary here", "surfBiteSource": "brief attribution, e.g. site names you drew from"}`;
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

  let result;
  try {
    result = await callClaude(buildPrompt(existing.waterTemp));
  } catch (err) {
    console.error("Surf report update failed, leaving previous value in place:", err.message);
    process.exit(0);
  }

  if (!result.surfBiteReport) {
    console.error("Unexpected response shape, leaving previous value in place.");
    process.exit(0);
  }

  const updated = {
    ...existing,
    surfBiteReport: result.surfBiteReport,
    surfBiteSource: `${result.surfBiteSource} · Auto-refreshed via Claude API`,
    surfBiteUpdated: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }),
  };

  await writeFile(OUT_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log("Surf report updated:", updated.surfBiteUpdated);
}

main();
