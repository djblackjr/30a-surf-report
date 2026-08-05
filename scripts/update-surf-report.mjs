// Finds a genuinely current, firsthand surf-fishing report for 30A and
// writes a short summary into conditions.json. Claude is used only to read
// unstructured articles/podcast summaries; source dates, hosts, and maximum
// ages are validated deterministically before anything reaches the app.

import { readFile, writeFile } from "fs/promises";

const OUT_PATH = new URL("../src/data/conditions.json", import.meta.url);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DAY_MS = 86_400_000;
const TIME_ZONE = "America/Chicago";
const SOURCE_RULES = {
  "facebook.com": { maxAgeDays: 7, priority: 1, kind: "social", label: "Reel30A Facebook" },
  "www.facebook.com": { maxAgeDays: 7, priority: 1, kind: "social", label: "Reel30A Facebook" },
  "m.facebook.com": { maxAgeDays: 7, priority: 1, kind: "social", label: "Reel30A Facebook" },
  "instagram.com": { maxAgeDays: 7, priority: 1, kind: "social", label: "Reel30A Instagram" },
  "www.instagram.com": { maxAgeDays: 7, priority: 1, kind: "social", label: "Reel30A Instagram" },
  "greatdaysoutdoors.com": { maxAgeDays: 14, priority: 2, kind: "editorial", label: "Northwest Florida Fishing Report / Reel30A" },
  "www.greatdaysoutdoors.com": { maxAgeDays: 14, priority: 2, kind: "editorial", label: "Northwest Florida Fishing Report / Reel30A" },
  "northwestfloridafishingreport.libsyn.com": { maxAgeDays: 14, priority: 2, kind: "podcast", label: "Northwest Florida Fishing Report / Reel30A" },
  "halfhitch.com": { maxAgeDays: 7, priority: 3, kind: "editorial", label: "Half Hitch PCB Fishing Report" },
  "www.halfhitch.com": { maxAgeDays: 7, priority: 3, kind: "editorial", label: "Half Hitch PCB Fishing Report" },
};

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY not set — skipping surf report update (non-fatal).");
  process.exit(0);
}

function localDateISO(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(date);
}

function buildPrompt(waterTemp, todayISO) {
  return `Today is ${todayISO}. Find the newest genuinely current surf-fishing catch report that applies to the 30A / South Walton beach corridor in Florida (Dune Allen, Blue Mountain Beach, Grayton Beach, Seagrove, or Inlet Beach).

Search in this order:
1. Public posts from Reel30A's official Facebook page (facebook.com/reel30a) or official Instagram account (@TheReel30A). A social post is acceptable only if it has a direct public post/reel URL, an explicit publication date within the last 7 days, a readable caption, and that caption reports actual catches or present surf-fishing conditions in the 30A / South Walton corridor. A promotional image, client photo without a useful caption, profile page, search snippet, relative date such as “3d,” or login-blocked post does not qualify.
2. Northwest Florida Fishing Report, on greatdaysoutdoors.com or northwestfloridafishingreport.libsyn.com. Prefer an episode or written summary featuring Blake Hunter of Reel30A and explicitly discussing 30A, South Walton, Miramar-to-Panama-City-Beach surf fishing, or the Emerald Coast surf. It is acceptable only if published within the last 14 days.
3. Half Hitch's Panama City Beach fishing-report series at halfhitch.com/blog. Use only a dated post with a real Surf Fishing section published within the last 7 days.

Do not use any Facebook or Instagram account other than the two exact Reel30A accounts above. Do not use NOE Outdoors, Reddit, generic seasonal forecasts, undated guide pages, charter advertising, old articles, search-result snippets you cannot open, or offshore/pier reports presented as surf reports. Do not infer a current bite from a photo, weather, water temperature, past seasonal patterns, or a report older than its allowed window.

If a qualifying source exists, summarize only what it actually reports about surf-zone catches, bait, grass/water clarity, beach structure, and tactics in 3-5 concise sentences. Paraphrase; do not quote. ${waterTemp ? `The app's current model sea-surface temperature is ${waterTemp}°F; do not describe it as a measured temperature and do not use it to invent a bite pattern.` : ""}

Return ONLY JSON:
{"status":"current","surfBiteReport":"summary","sources":[{"name":"source/publication and local expert","url":"direct article, episode, or social-post permalink","publishedDate":"YYYY-MM-DD","account":"TheReel30A only for Instagram; reel30a only for Facebook; omit for non-social sources"}]}

If nothing qualifies, return ONLY:
{"status":"unavailable","surfBiteReport":null,"sources":[]}`;
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
      max_tokens: 1400,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
}

function validateSources(sources, todayISO) {
  const today = new Date(`${todayISO}T12:00:00-05:00`);
  return (Array.isArray(sources) ? sources : []).flatMap((source) => {
    let url;
    try { url = new URL(source.url); } catch { return []; }
    const rule = SOURCE_RULES[url.hostname.toLowerCase()];
    if (!rule || url.protocol !== "https:") return [];
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    if (host.endsWith("facebook.com") && !/^\/reel30a\/(?:posts|photos|videos|reels)\//i.test(path)) return [];
    if (host.endsWith("instagram.com")) {
      if (!/^\/(?:p|reel)\/[A-Za-z0-9_-]+$/i.test(path)) return [];
      if ((source.account || "").replace(/^@/, "").toLowerCase() !== "thereel30a") return [];
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(source.publishedDate || "")) return [];
    const published = new Date(`${source.publishedDate}T12:00:00-05:00`);
    const ageDays = Math.floor((today - published) / DAY_MS);
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > rule.maxAgeDays) return [];
    return [{ name: rule.label, url: url.href, publishedDate: source.publishedDate, ageDays, kind: rule.kind, priority: rule.priority }];
  }).sort((a, b) => a.priority - b.priority || a.ageDays - b.ageDays);
}

function unavailableFields(refreshedAt) {
  return {
    surfBiteStatus: "unavailable",
    surfBiteReport: "No current local 30A surf-fishing report is available from the monitored firsthand sources.",
    surfBiteSource: null,
    surfBiteSourceUrl: null,
    surfBiteSourceDate: null,
    surfBiteSourceKind: null,
    surfBiteRefreshedAt: refreshedAt,
  };
}

async function main() {
  const existing = JSON.parse(await readFile(OUT_PATH, "utf-8"));
  if (!existing.shared) throw new Error("conditions.json is missing `shared`; run update-conditions.mjs first");

  const todayISO = localDateISO();
  const refreshedAt = new Date().toISOString();
  const waterTemp = existing.locations?.["grayton-beach"]?.waterTemp;
  let result;
  try {
    result = await callClaude(buildPrompt(waterTemp, todayISO));
  } catch (err) {
    console.error("Surf report research failed, leaving previous value in place:", err.message);
    process.exit(0);
  }

  const sources = validateSources(result.sources, todayISO);
  const hasCurrentReport = result.status === "current" && typeof result.surfBiteReport === "string"
    && result.surfBiteReport.trim().length > 0 && sources.length > 0;
  const primary = sources[0];
  const fields = hasCurrentReport ? {
    surfBiteStatus: "current",
    surfBiteReport: result.surfBiteReport.trim(),
    surfBiteSource: sources.map((s) => `${s.name} (${s.publishedDate})`).join(" + "),
    surfBiteSourceUrl: primary.url,
    surfBiteSourceDate: primary.publishedDate,
    surfBiteSourceKind: primary.kind,
    surfBiteRefreshedAt: refreshedAt,
  } : unavailableFields(refreshedAt);

  const updated = { ...existing, shared: { ...existing.shared, ...fields } };
  // Remove the legacy refresh-date field: freshness now comes from the
  // publication date of the underlying report, not the day Claude checked.
  delete updated.shared.surfBiteUpdated;
  await writeFile(OUT_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log(hasCurrentReport
    ? `Surf report updated from ${primary.name}, published ${primary.publishedDate}`
    : "No qualifying report found; published an explicit unavailable state");
}

main().catch((err) => {
  console.error("Surf report update failed, leaving conditions.json untouched:", err.message);
  process.exit(1);
});
