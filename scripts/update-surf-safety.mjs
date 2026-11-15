// Fetches today's official South Walton flag and the NWS Tallahassee Surf
// Zone Forecast without an LLM or private API. Both inputs are public,
// deterministic sources and can be refreshed by GitHub Actions for free.

import { readFile, writeFile } from "fs/promises";

const OUT_PATH = new URL("../src/data/conditions.json", import.meta.url);
const USER_AGENT = "30a-surf-report (github.com/djblackjr/30a-surf-report)";
const FLAG_URL = "https://www.visitsouthwalton.com/beach-safety/";
const FLAG_API_URL = "https://www.visitsouthwalton.com/api/flag/";
const NWS_PRODUCTS_URL = "https://api.weather.gov/products/types/SRF/locations/TAE";

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json,application/json" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// Maps a flag color/label/image name to one of our colors. Checked against
// <flagcolor>, then <condition> ("Medium Hazard"), then the image URL.
// Order matters: "double red" / "water closed" must win over plain "red".
const FLAG_PATTERNS = [
  ["double red", /double[\s_-]*red|water[\s_-]*closed|closed[\s_-]*to[\s_-]*public/i],
  ["red", /\bred\b|high[\s_-]*hazard/i],
  ["yellow", /yellow|medium[\s_-]*hazard/i],
  ["green", /green|low[\s_-]*hazard/i],
];

function flagColorFrom(...labels) {
  for (const label of labels.filter(Boolean)) {
    const hit = FLAG_PATTERNS.find(([, re]) => re.test(label));
    if (hit) return hit[0];
  }
  return null;
}

function xmlText(xml, tag) {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))?.[1]?.trim() || "";
}

// Since ~Oct 2026 visitsouthwalton.com renders the flag client-side from this
// endpoint (fed by SWFD) instead of server HTML. It returns XML like:
//   <beach><flagcolor>yellow</flagcolor><condition>Medium Hazard</condition>
//     <flag>//www.swfd.org/.../yellow.png</flag><date>2026-11-14 03:19:26</date>
//     <marinepests><status>1</status>...</marinepests></beach>
async function fetchOfficialFlag() {
  const res = await fetch(FLAG_API_URL, { headers: { "User-Agent": USER_AGENT, Accept: "application/xml,text/xml" } });
  if (!res.ok) throw new Error(`${FLAG_API_URL} -> ${res.status}`);
  const xml = await res.text();
  const [main, pests = ""] = xml.split(/<marinepests>/i);
  const color = flagColorFrom(xmlText(main, "flagcolor"), xmlText(main, "condition"), xmlText(main, "flag"));
  if (!color) throw new Error(`Could not parse the official flag color from: ${xml.slice(0, 200)}`);
  return {
    color,
    purpleFlag: xmlText(pests, "status") === "1",
    postedAt: xmlText(main, "date") || null, // SWFD local time (Central), as published
  };
}

function normalizeSurfHeight(value) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .replace(/around\s+(\d+)\s+foot/i, "around $1 ft")
    .replace(/(\d+)\s+to\s+(\d+)\s+feet/i, "$1-$2 ft")
    .replace(/(\d+)\s+feet/i, "$1 ft");
}

function parseSouthWalton(productText) {
  const normalized = productText.replace(/\r/g, "");
  const section = normalized.match(/FLZ108-[\s\S]*?(?=\n\$\$|\nFLZ\d{3}-|$)/)?.[0];
  if (!section) throw new Error("South Walton (FLZ108) section missing from NWS SRF product");

  const risk = section.match(/Rip Current Risk\.*\s*(Low|Moderate|High)/i)?.[1]?.toLowerCase() || "unknown";
  const rawHeight = section.match(/Surf Height\.*\s*([^\n]+)/i)?.[1];
  const surfHeight = rawHeight ? normalizeSurfHeight(rawHeight) : "unknown";
  const waltonFlag = normalized.match(/^\s*Walton\.*\s*(Double Red|Green|Yellow|Red)\s*$/im)?.[1]?.toLowerCase() || null;
  return { risk, surfHeight, waltonFlag };
}

async function fetchNwsSurfForecast() {
  const listing = await getJson(NWS_PRODUCTS_URL);
  const latest = [...(listing["@graph"] || [])]
    .sort((a, b) => new Date(b.issuanceTime || 0) - new Date(a.issuanceTime || 0))[0];
  if (!latest?.id) throw new Error("No NWS Tallahassee SRF products returned");
  const product = await getJson(`https://api.weather.gov/products/${latest.id}`);
  const parsed = parseSouthWalton(product.productText || "");
  return {
    ...parsed,
    issuedAt: product.issuanceTime || latest.issuanceTime || null,
    productId: latest.id,
  };
}

function ageHours(iso) {
  if (!iso) return null;
  const age = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return Number.isFinite(age) ? age : null;
}

async function main() {
  const existing = JSON.parse(await readFile(OUT_PATH, "utf-8"));
  if (!existing.shared) throw new Error("conditions.json is missing `shared`; run update-conditions.mjs first");

  const [flagResult, nwsResult] = await Promise.allSettled([
    fetchOfficialFlag(),
    fetchNwsSurfForecast(),
  ]);
  const officialFlag = flagResult.status === "fulfilled" ? flagResult.value : null;
  const nws = nwsResult.status === "fulfilled" ? nwsResult.value : null;
  if (!officialFlag) console.warn("Official flag fetch failed:", flagResult.reason?.message);
  if (!nws) console.warn("NWS surf forecast fetch failed:", nwsResult.reason?.message);

  const nwsAge = ageHours(nws?.issuedAt);
  const nwsFresh = nwsAge != null && nwsAge <= 30;
  const previous = existing.shared.beachFlag || {};
  const color = officialFlag?.color || (nwsFresh ? nws?.waltonFlag : null) || "unknown";
  const purpleFlag = officialFlag ? officialFlag.purpleFlag : false;
  const ripCurrentRisk = nwsFresh ? nws.risk : "unknown";
  const surfHeight = nwsFresh ? nws.surfHeight : "unknown";

  const notes = [
    color === "unknown" ? "Today's official flag could not be verified; check the posted flag before entering the Gulf." : null,
    !officialFlag && color !== "unknown" ? "Flag color is from the NWS surf-zone forecast; the official SWFD flag could not be read." : null,
    !nwsFresh ? "A current NWS South Walton surf-zone forecast could not be verified." : null,
    purpleFlag ? "Purple flag: potentially hazardous marine life is reported." : null,
  ].filter(Boolean).join(" ") || "Official flag and current NWS South Walton surf-zone forecast verified.";

  const sourceParts = [];
  if (officialFlag) sourceParts.push("Visit South Walton official flag widget");
  else if (nwsFresh && nws.waltonFlag) sourceParts.push("NWS Tallahassee reported Walton flag");
  if (nwsFresh) sourceParts.push("NWS Tallahassee Surf Zone Forecast (FLZ108)");

  const updated = {
    ...existing,
    shared: {
      ...existing.shared,
      beachFlag: {
        ...previous,
        color,
        ripCurrentRisk,
        surfHeight,
        purpleFlag,
        notes,
        source: sourceParts.join(" + ") || "No current source available",
        sourceUrl: officialFlag ? FLAG_URL : null,
        officialPostedAt: officialFlag?.postedAt || null,
        nwsProductUrl: nws?.productId ? `https://api.weather.gov/products/${nws.productId}` : null,
        nwsIssuedAt: nws?.issuedAt || null,
        updatedAt: new Date().toISOString(),
        updated: new Date().toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago",
        }),
      },
    },
  };

  await writeFile(OUT_PATH, JSON.stringify(updated, null, 2) + "\n");
  console.log("Beach safety updated:", color, "·", ripCurrentRisk, "rip risk ·", surfHeight);
}

main().catch((err) => {
  console.error("Beach safety update failed, leaving conditions.json untouched:", err.message);
  process.exit(1);
});
