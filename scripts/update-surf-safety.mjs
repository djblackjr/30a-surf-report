// Fetches today's official South Walton flag and the NWS Tallahassee Surf
// Zone Forecast without an LLM or private API. Both inputs are public,
// deterministic sources and can be refreshed by GitHub Actions for free.

import { readFile, writeFile } from "fs/promises";

const OUT_PATH = new URL("../src/data/conditions.json", import.meta.url);
const USER_AGENT = "30a-surf-report (github.com/djblackjr/30a-surf-report)";
const FLAG_URL = "https://www.visitsouthwalton.com/beach-safety/";
const NWS_PRODUCTS_URL = "https://api.weather.gov/products/types/SRF/locations/TAE";

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json,application/json" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function fetchOfficialFlag() {
  const html = await getText(FLAG_URL);
  const idx = html.indexOf('class="flagWrapper"');
  if (idx === -1) throw new Error("flagWrapper widget not found — site layout may have changed");
  const block = html.slice(idx, idx + 1200);
  const altMatch = block.match(/<img alt="((?:Double Red|Green|Yellow|Red)[^"]*)"/i);
  const colorMatch = altMatch?.[1]?.match(/double red|green|yellow|red/i);
  if (!colorMatch) throw new Error("Could not parse the official flag color");
  return {
    color: colorMatch[0].toLowerCase(),
    purpleFlag: /Marine Pests Flag/i.test(block),
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
