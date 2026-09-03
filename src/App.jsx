import { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import dailyData from "./data/conditions.json";
import LOCATIONS from "./data/locations.json";

const DEFAULT_LOCATION_ID = "grayton-beach";
const LOCATION_STORAGE_KEY = "30a-location";

// ── SHARED CONDITIONS ─────────────────────────────────────────────────────────
// Same split as the sibling 331 Bridge app: only evergreen config lives here.
// Everything day-to-day (wind, weather, tide, wave/swell, beach flag, bite
// report) comes from src/data/conditions.json, which the daily scripts
// overwrite automatically. `access` lives per-location in locations.json
// instead, since every beach has its own park/address details — regs and
// the surf-reading tip below are genuinely statewide/generic, so they stay
// here regardless of which beach is selected.
const STATIC_CONDITIONS = {
  readingTheSurf: "Pompano and whiting feed in the troughs — the shallow gutters between the beach and the first sandbar, and between the first and second sandbars — not out past the bar. Don't cast over the fish: the first 20-40 yards is usually the money water. Sand fleas (mole crabs) washing out of the swash are the tell that pompano are actively feeding right there.",
  regulations: [
    { species: "Pompano", rules: "11 in fork length min · 6 per person per day" },
    { species: "Whiting (Sea Mullet)", rules: "No size or bag limit" },
    { species: "Redfish", rules: "18–27 in · 1 per person per day" },
    { species: "Bluefish", rules: "No size limit · 10 per person per day" },
    { species: "Sheepshead", rules: "12 in min · 8 per person per day" },
    { species: "Spanish Mackerel", rules: "12 in fork length min · 15 per person per day" },
    { species: "Sharks (shore-based)", rules: "Free permit + FWC educational course required · non-stainless circle hooks on natural bait · must have a cutting device · 29 prohibited species must be released without leaving the water" },
    { species: "License", rules: "FL saltwater fishing license required" },
    { species: "Verify", rules: "Always confirm at myfwc.com — regulations change" },
  ],
};

function buildConditions(locationId) {
  const loc = LOCATIONS.find((l) => l.id === locationId) || LOCATIONS.find((l) => l.id === DEFAULT_LOCATION_ID);
  const locationDaily = dailyData.locations?.[loc.id] || {};
  return {
    ...dailyData.shared,
    ...locationDaily,
    ...STATIC_CONDITIONS,
    locationId: loc.id,
    locationName: loc.name,
    access: loc.access,
  };
}

// ── RATING SYSTEM ────────────────────────────────────────────────────────────
function ratingLabel(score) {
  if (score >= 8) return "Excellent";
  if (score >= 7) return "Good";
  if (score >= 5.5) return "Fair";
  return "Poor";
}
function ratingColor(score) {
  return score >= 7.5 ? "#4ade80" : score >= 6 ? "#facc15" : "#f87171";
}

// Folds in the two things that matter most for surf fishing specifically and
// that a plain weather forecast can't capture: whether the beach is actually
// open (flag color) and whether the surf is fishable (wave height). A great
// wind/storm forecast day is still a bad day to wade the wash if it's double
// red or the swell is pushing 4ft.
function surfScore(C) {
  let score = C.forecast?.[0]?.fishingScore ?? 7;
  const flag = C.beachFlag?.color;
  if (flag === "red") score -= 2;
  else if (flag === "yellow") score -= 0.5;
  if (C.beachFlag?.ripCurrentRisk === "high") score -= 1;
  const waveHeight = C.wave?.height;
  if (typeof waveHeight === "number" && waveHeight > 3) score -= 1;
  return Math.max(1, Math.min(9.5, Math.round(score * 10) / 10));
}

// A "double red" (water closed) or "unknown" flag overrides the numeric
// score's label entirely — a 7.8 doesn't mean much if you legally/safely
// can't be in the water at all.
function surfStatusLabel(C, score) {
  if (C.beachFlag?.color === "double red") return "Closed";
  if (C.beachFlag?.color === "unknown") return "Check flags";
  return ratingLabel(score);
}
function surfStatusColor(C, score) {
  if (C.beachFlag?.color === "double red") return "#f87171";
  if (C.beachFlag?.color === "unknown") return "#7ab898";
  return ratingColor(score);
}

// ── TIME HELPERS ─────────────────────────────────────────────────────────────
function timeToMinutes(t) {
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let [, h, min, ap] = m;
  h = parseInt(h, 10); min = parseInt(min, 10);
  if (/PM/i.test(ap) && h !== 12) h += 12;
  if (/AM/i.test(ap) && h === 12) h = 0;
  return h * 60 + min;
}
function minutesToTime(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  let h = Math.floor(mins / 60), m = Math.round(mins % 60);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

// Live countdown to the next sunrise/sunset, adapted from the 331 Bridge
// app's suncalc-driven sun display — this app already has sunrise/sunset
// strings in conditions.json, so no new dependency is needed, just a ticking
// clock against the two known times-of-day.
function getSunStatus(sunrise, sunset) {
  const sr = timeToMinutes(sunrise || "6:00 AM");
  const ss = timeToMinutes(sunset || "7:00 PM");
  if (sr == null || ss == null) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isDaylight = nowMin >= sr && nowMin < ss;
  const targetMin = isDaylight ? ss : nowMin < sr ? sr : sr + 1440;
  const diff = targetMin - nowMin;
  const h = Math.floor(diff / 60), m = diff % 60;
  return {
    isDaylight,
    label: isDaylight ? "🌇 Sunset" : "🌅 Sunrise",
    text: h > 0 ? `${h}h ${m}m` : `${m}m`,
  };
}

function SunCountdown({ sunrise, sunset }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const status = getSunStatus(sunrise, sunset);
  if (!status) return null;
  return (
    <div style={{ flex: 1, minWidth: 140, background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>{status.label}</div>
      <div style={{ fontSize: 15, color: "#f5faff" }}>in {status.text}</div>
    </div>
  );
}

function getBestWindow(C) {
  const sunrise = timeToMinutes(C.sunrise || "6:00 AM");
  let end = sunrise + 5 * 60;
  let reason = "before the afternoon heat builds";
  const stormWindow = C.stormWindow || "";
  const stormMatch = stormWindow.match(/before\s+(\d+)\s*(AM|PM)/i);
  if (stormMatch) {
    const stormEnd = timeToMinutes(`${stormMatch[1]}:00 ${stormMatch[2]}`);
    if (stormEnd && stormEnd < end) {
      end = stormEnd - 30;
      reason = `before storms build (${stormWindow})`;
    }
  }
  return { start: sunrise, end, startText: minutesToTime(sunrise), endText: minutesToTime(end), reason };
}

function getConditionsDiff(C) {
  const prev = C.previousDay;
  if (!prev || !Object.keys(prev).length) return null;
  const changes = [];
  if (prev.wind?.dir && prev.wind.dir !== C.wind.dir) {
    changes.push(`wind shifted ${prev.wind.dir} → ${C.wind.dir}`);
  }
  const todayHigh = C.forecast?.[0]?.high;
  if (typeof prev.high === "number" && typeof todayHigh === "number" && prev.high !== todayHigh) {
    const dir = todayHigh > prev.high ? "up" : "down";
    changes.push(`high ${dir} ${Math.abs(todayHigh - prev.high)}° (${prev.high}° → ${todayHigh}°)`);
  }
  const todayStorms = C.stormChance ?? C.forecast?.[0]?.storms ?? 0;
  if (typeof prev.stormChance === "number" && prev.stormChance !== todayStorms) {
    const dir = todayStorms > prev.stormChance ? "up" : "down";
    changes.push(`storm chance ${dir} ${Math.abs(todayStorms - prev.stormChance)}% (${prev.stormChance}% → ${todayStorms}%)`);
  }
  const prevWave = prev.wave?.height, todayWave = C.wave?.height;
  if (typeof prevWave === "number" && typeof todayWave === "number" && Math.abs(prevWave - todayWave) >= 0.5) {
    const dir = todayWave > prevWave ? "up" : "down";
    changes.push(`surf ${dir} to ${todayWave}ft (was ${prevWave}ft)`);
  }
  if (changes.length === 0) return "Conditions steady since yesterday — no meaningful change in wind, surf, or storm risk.";
  return `Since yesterday: ${changes.join(" · ")}.`;
}

// NWS and Open-Meteo are independent weather forecast sources. This simple
// average is a quick consensus view for temperature and precipitation only;
// it deliberately does not average the official beach flag, NWS rip risk,
// or Open-Meteo marine-model wave guidance.
function averageWeatherForecast(C) {
  const nws = C.forecast?.[0];
  const openMeteo = C.openMeteo?.[0];
  const highs = [nws?.high, openMeteo?.high].filter((v) => typeof v === "number");
  const storms = [nws?.storms, openMeteo?.stormChance].filter((v) => typeof v === "number");
  const avg = (values) => values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
  return { high: avg(highs), storms: avg(storms), sourceCount: Math.min(highs.length, storms.length) };
}

// ── WIND DIRECTION HELPERS ───────────────────────────────────────────────────
const DIR16_TO_DEG = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
function dirToDegrees(dir) { return DIR16_TO_DEG[dir] ?? 0; }
const OCTANTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function nearestOctant(dir) { return OCTANTS[Math.round(dirToDegrees(dir) / 45) % 8]; }

// Grayton Beach faces roughly south. Onshore (S/SW/SE) wind builds and roils
// the surf; offshore (N/NW/NE) flattens and clears it. This is the surf
// equivalent of the bay app's per-direction wind guidance table.
function windSurfNote(dir) {
  const oct = nearestOctant(dir);
  if (["S", "SW", "SE"].includes(oct)) return "Onshore — builds surf and stirs up the wash. Good for moving bait/scent, tougher for sight-fishing or wading comfortably.";
  if (["N", "NW", "NE"].includes(oct)) return "Offshore — flattens and clears the water. Usually the best conditions for sight-fishing and wading the troughs.";
  return "Cross-shore — surf and clarity somewhere in between onshore and offshore days.";
}

// ── VISUAL COMPONENTS (ported from the sibling 331 Bridge app — generic,
// not bay-specific, so they transfer as-is) ─────────────────────────────────
function ScoreRing({ score, size = 82 }) {
  const stroke = Math.max(6, size * 0.085);
  const c = size / 2, r = c - stroke;
  const circ = 2 * Math.PI * r, fill = (score / 10) * circ;
  const color = score >= 7.5 ? "#4ade80" : score >= 6 ? "#facc15" : "#f87171";
  const numSize = size * 0.22, subSize = size * 0.12;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="#12314a" strokeWidth={stroke} />
      <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${c} ${c})`} style={{ transition: "all 0.8s ease" }} />
      <text x={c} y={c - numSize * 0.18} textAnchor="middle" fill={color} fontSize={numSize} fontWeight="700" fontFamily="'Space Grotesk',sans-serif">{score}</text>
      <text x={c} y={c + numSize * 0.58} textAnchor="middle" fill="#7fb3d9" fontSize={subSize} fontFamily="'Space Grotesk',sans-serif">/10</text>
    </svg>
  );
}

function WindCompass({ dir, size = 64 }) {
  const deg = dirToDegrees(dir);
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={c} cy={c} r={c - 3} fill="none" stroke="#12314a" strokeWidth="2" />
      {["N", "E", "S", "W"].map((d) => {
        const a = (DIR16_TO_DEG[d] - 90) * (Math.PI / 180);
        const x = c + (c - 12) * Math.cos(a), y = c + (c - 12) * Math.sin(a);
        return <text key={d} x={x} y={y + 4} textAnchor="middle" fontSize="10" fill="#4a7396" fontFamily="'Space Grotesk',sans-serif">{d}</text>;
      })}
      <g transform={`rotate(${deg} ${c} ${c})`}>
        <line x1={c} y1={c + 14} x2={c} y2={c - 14} stroke="#5ec8f2" strokeWidth="3" strokeLinecap="round" />
        <polygon points={`${c - 6},${c - 8} ${c + 6},${c - 8} ${c},${c - 18}`} fill="#5ec8f2" />
      </g>
    </svg>
  );
}

function parseStormRange(stormWindow) {
  if (!stormWindow) return null;
  const m = stormWindow.match(/(before|after)\s+(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  const mins = timeToMinutes(`${m[2]}:00 ${m[3]}`);
  if (mins == null) return null;
  return m[1].toLowerCase() === "before" ? [0, mins] : [mins, 1440];
}

function TideCurve({ events, sunrise, sunset, stormWindow, stormChance }) {
  if (!events || events.length < 2) return null;
  const pts = events.map(e => ({ ...e, mins: timeToMinutes(e.time) })).filter(e => e.mins != null).sort((a, b) => a.mins - b.mins);
  if (pts.length < 2) return null;
  const nowMins = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();

  const vbW = 400, vbH = 230;
  const padX = 30;
  const curveTopY = 54;
  const curveBottomY = 138;
  const axisY = 200;
  const tickLabelY = 222;

  const w = vbW - padX * 2;
  const yFor = (type) => type === "H" ? curveTopY : curveBottomY;
  const xFor = (mins) => padX + (mins / 1440) * w;

  const avgInterval = pts.length >= 2
    ? (pts[pts.length - 1].mins - pts[0].mins) / (pts.length - 1)
    : 360;

  const anchors = [...pts];
  while (anchors[0].mins > -60) {
    const prevType = anchors[0].type === "H" ? "L" : "H";
    anchors.unshift({ mins: anchors[0].mins - avgInterval, type: prevType });
  }
  while (anchors[anchors.length - 1].mins < 1500) {
    const nextType = anchors[anchors.length - 1].type === "H" ? "L" : "H";
    anchors.push({ mins: anchors[anchors.length - 1].mins + avgInterval, type: nextType });
  }

  const SAMPLES_PER_SEGMENT = 24;
  const pathPoints = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    const yA = yFor(a.type), yB = yFor(b.type);
    for (let s = 0; s <= SAMPLES_PER_SEGMENT; s++) {
      if (i > 0 && s === 0) continue;
      const f = s / SAMPLES_PER_SEGMENT;
      const eased = (1 - Math.cos(f * Math.PI)) / 2;
      const mins = a.mins + (b.mins - a.mins) * f;
      if (mins < -20 || mins > 1460) continue;
      const y = yA + (yB - yA) * eased;
      pathPoints.push([xFor(mins), y]);
    }
  }
  const path = pathPoints.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

  const hourTicks = [0, 360, 720, 1080, 1440].map((m, i) => ({ mins: m, label: ["12A", "6A", "12P", "6P", "12A"][i] }));
  const stormRange = (stormChance >= 20) ? parseStormRange(stormWindow) : null;

  return (
    <div style={{ width: "100%", aspectRatio: `${vbW} / ${vbH}`, maxWidth: 460, margin: "0 auto" }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
        {stormRange && (
          <rect x={xFor(stormRange[0])} y="4" width={xFor(stormRange[1]) - xFor(stormRange[0])} height={axisY - 4} fill="#f87171" opacity="0.12" />
        )}
        <path d={path} fill="none" stroke="#5ec8f2" strokeWidth="4" strokeLinecap="round" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={xFor(p.mins)} cy={yFor(p.type)} r="7" fill="#5ec8f2" />
            <text x={xFor(p.mins)} y={p.type === "H" ? curveTopY - 18 : curveBottomY + 30} textAnchor="middle" fontSize="19" fontWeight="700" fill="#eaf5ff" fontFamily="'Space Grotesk',sans-serif">{p.type === "H" ? "High" : "Low"}</text>
            <text x={xFor(p.mins)} y={p.type === "H" ? curveTopY - 2 : curveBottomY + 48} textAnchor="middle" fontSize="17" fill="#7fb3d9" fontFamily="'Space Grotesk',sans-serif">{p.time}</text>
          </g>
        ))}
        <line x1={xFor(nowMins)} y1="14" x2={xFor(nowMins)} y2={axisY} stroke="#facc15" strokeWidth="2" strokeDasharray="4,4" />
        <text x={xFor(nowMins)} y="12" textAnchor="middle" fontSize="13" fontWeight="700" fill="#facc15" fontFamily="'Space Grotesk',sans-serif">now</text>
        <line x1={padX} y1={axisY} x2={vbW - padX} y2={axisY} stroke="#12314a" strokeWidth="1.5" />
        {hourTicks.map((t, i) => (
          <g key={i}>
            <line x1={xFor(t.mins)} y1={axisY - 4} x2={xFor(t.mins)} y2={axisY + 4} stroke="#12314a" strokeWidth="1.5" />
            <text x={xFor(t.mins)} y={tickLabelY} textAnchor="middle" fontSize="13" fill="#4a7396" fontFamily="'Space Grotesk',sans-serif">{t.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 10, border: "1px solid #12314a", borderRadius: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", background: "#0e2439", border: "none", padding: "11px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "'Space Grotesk',sans-serif" }}>
        <span style={{ fontSize: 16, color: "#7fb3d9", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>{title}</span>
        <span style={{ color: "#7fb3d9", fontSize: 16, transform: open ? "rotate(180deg)" : "none", transition: "0.2s" }}>▾</span>
      </button>
      {open && <div style={{ padding: "0 16px 14px", background: "#071624" }}>{children}</div>}
    </div>
  );
}

// ── BEACH FLAG BANNER — the one thing this app has that the bay app never
// needed. Shown above the score hero on purpose: whether the water is
// legally/safely open matters before "how good is the bite." ────────────────
const FLAG_STYLE = {
  green:       { bg: "#0d2b18", border: "#4ade8066", dot: "#4ade80", label: "Green flag — low hazard" },
  yellow:      { bg: "#2a2306", border: "#facc1566", dot: "#facc15", label: "Yellow flag — medium hazard" },
  red:         { bg: "#2a0f0f", border: "#f8717166", dot: "#f87171", label: "Red flag — high hazard" },
  "double red":{ bg: "#2a0f0f", border: "#f87171",   dot: "#f87171", label: "Double red — water closed to the public" },
  unknown:     { bg: "#0e2439", border: "#12314a",   dot: "#7fb3d9", label: "Flag status unknown" },
};
function BeachFlagBanner({ C }) {
  const flag = C.beachFlag || {};
  const style = FLAG_STYLE[flag.color] || FLAG_STYLE.unknown;
  return (
    <div style={{ background: style.bg, border: `1px solid ${style.border}`, borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: style.dot, flexShrink: 0, border: flag.color === "double red" ? "2px solid #fff3" : "none" }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: "#eaf5ff" }}>{style.label}</div>
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 14, color: "#a9c8e0", marginTop: 6 }}>
        {flag.ripCurrentRisk && flag.ripCurrentRisk !== "unknown" && <span>🌀 Rip risk: <b style={{ color: "#eaf5ff" }}>{flag.ripCurrentRisk}</b></span>}
        {flag.surfHeight && <span>🌊 Surf: <b style={{ color: "#eaf5ff" }}>{flag.surfHeight}</b></span>}
        {flag.purpleFlag && <span style={{ color: "#c9a6f8" }}>🪼 Purple flag — marine life reported</span>}
      </div>
      {flag.notes && <div style={{ fontSize: 14, color: "#a9c8e0", marginTop: 6, lineHeight: 1.5 }}>{flag.notes}</div>}
      <div style={{ fontSize: 12, color: "#4a7396", marginTop: 6 }}>
        {flag.updated ? `Checked ${flag.updated}` : "Not yet checked"} · always verify with posted flags before entering the water
      </div>
    </div>
  );
}

// ── LIVE RADAR ───────────────────────────────────────────────────────────────
// Same Windy.com embed pattern as the sibling 331 Bridge app — makes "watch
// the radar" (called out in the storm-chance blurb above) actually
// actionable instead of requiring a second app. Unlike 331 (single fixed
// location), this app has 5 beaches, so the embed recenters on whichever
// beach is currently selected.
function RadarPanel({ lat, lon, locationName }) {
  return (
    <Collapsible title="🌧️ Live Radar" defaultOpen>
      <div style={{ marginTop: 10, borderRadius: 8, overflow: "hidden", border: "1px solid #12314a" }}>
        <iframe
          key={`${lat},${lon}`}
          title={`Live radar — ${locationName}, FL`}
          src={`https://embed.windy.com/embed2.html?lat=${lat}&lon=${lon}&detailLat=${lat}&detailLon=${lon}&width=650&height=400&zoom=8&level=surface&overlay=radar&menu=&message=true&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=default&metricTemp=default&radarRange=-1`}
          width="100%" height="320" frameBorder="0" style={{ display: "block" }}
        />
      </div>
      <div style={{ fontSize: 13, color: "#7fb3d9", marginTop: 6, textAlign: "center" }}>Live radar via Windy.com</div>
    </Collapsible>
  );
}

// ── BEACH MAP ────────────────────────────────────────────────────────────────
// The 331 Bridge app's "Fishing Intelligence Atlas" is a full SQLite +
// GeoJSON pipeline mapping bay fishing structures — built for dozens of
// structure spots across one bay. That doesn't translate here: this app has
// exactly 5 named beaches (already geocoded in locations.json), and there's
// no verified sandbar/rip-channel geodata to plot — fabricating precise surf
// hazard locations for a safety-relevant page would be actively irresponsible.
// So this is the honest, useful equivalent instead: an interactive map of the
// 5 real, verified beach accesses, color-coded by today's score, that doubles
// as another way to switch beaches. Plain Leaflet (no react-leaflet dep,
// matching 331's own reasoning) with vector circle markers instead of the
// default pin icon, which sidesteps Leaflet's well-known bundler asset-path
// breakage entirely.
function BeachMap({ locationId, onSelect }) {
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // A plain useEffect+useRef pair only fires once, when BeachMap itself
  // mounts — but Collapsible unmounts its children while collapsed
  // ({open && children}), so with defaultOpen={false} the container <div>
  // doesn't exist yet on that first (only) effect run and the map silently
  // never initializes. A callback ref fires exactly when the DOM node
  // actually appears/disappears, so it survives the panel being collapsed
  // and reopened.
  const containerRef = useCallback((node) => {
    if (node) {
      const map = L.map(node, { scrollWheelZoom: false }).setView([30.32, -86.15], 11);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 17,
      }).addTo(map);

      LOCATIONS.forEach((loc) => {
        const locC = buildConditions(loc.id);
        const score = surfScore(locC);
        const marker = L.circleMarker([loc.lat, loc.lon], {
          radius: 10,
          weight: loc.id === locationId ? 4 : 2,
          color: loc.id === locationId ? "#5ec8f2" : "#0b2a3d",
          fillColor: surfStatusColor(locC, score),
          fillOpacity: 0.9,
        }).addTo(map);
        marker.bindPopup(`<b>${loc.name}</b><br/>${score}/10 · ${surfStatusLabel(locC, score)}`);
        marker.on("click", () => onSelectRef.current(loc.id));
        markersRef.current[loc.id] = marker;
      });

      mapRef.current = map;
    } else if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      markersRef.current = {};
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-highlight the active marker on selection change without rebuilding the map
  useEffect(() => {
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      marker.setStyle({ weight: id === locationId ? 4 : 2, color: id === locationId ? "#5ec8f2" : "#0b2a3d" });
    });
  }, [locationId]);

  return (
    <Collapsible title="🗺️ Beach Map" defaultOpen={false}>
      <div style={{ marginTop: 10, borderRadius: 8, overflow: "hidden", border: "1px solid #12314a" }}>
        <div ref={containerRef} style={{ height: 280 }} />
      </div>
      <div style={{ fontSize: 13, color: "#7fb3d9", marginTop: 6, textAlign: "center" }}>Dot color = today's score at that beach · tap a dot to switch</div>
    </Collapsible>
  );
}

// ── BAIT / RIG PICKER ────────────────────────────────────────────────────────
// Same "check off what you've got" pattern as the sibling 331 Bridge app's
// BaitPicker, but the bait list and every rig/tip below is rewritten from
// scratch for beach/surf fishing — 331's content (mud minnows, fiddler crabs,
// oyster bars, pilings) is all estuary/bay tackle and doesn't apply to
// casting into a Gulf trough. Species referenced match this app's own
// STATIC_CONDITIONS.regulations list above.
const ALL_SURF_BAITS = [
  { id: "none",         label: "None / Bare Hook", emoji: "🚫" },
  { id: "sand_fleas",   label: "Sand Fleas",       emoji: "🦀" },
  { id: "shrimp",       label: "Fresh/Live Shrimp", emoji: "🦐" },
  { id: "cut_bait",     label: "Cut Mullet/Bait",  emoji: "🐟" },
  { id: "fishbites",    label: "FishBites/Gulp",   emoji: "🪱" },
  { id: "artificials",  label: "Artificials Only", emoji: "🪝" },
];

const SURF_BAIT_RECS = {
  sand_fleas: {
    rigs: [
      { name: "Pompano (Hi-Lo) Rig", detail: "2–3 oz pyramid sinker · two dropper loops above it, size 1–2 hooks · cast into the trough between sandbars" },
      { name: "Single flea, Kahle hook", detail: "Hook through the tail/back so it keeps kicking · fish just past the first sandbar break" },
    ],
    tip: "The gold-standard pompano and whiting bait. Hook through the back, not the body, so it still kicks. Fleas washing out of the swash are the tell — pompano are usually feeding right there.",
  },
  shrimp: {
    rigs: [
      { name: "Pompano rig", detail: "Peeled tail piece on a long-shank hook · 2–3 oz pyramid sinker · cast into the trough" },
      { name: "Fish-finder rig", detail: "Sliding egg sinker · 18-in fluorocarbon leader · whole shrimp on a circle hook for redfish and bigger whiting" },
    ],
    tip: "Fresh dead beats frozen almost every time in the surf. Peel the shell for pompano and whiting; leave shrimp whole for redfish.",
  },
  cut_bait: {
    rigs: [
      { name: "Fish-finder rig", detail: "3–5 oz sinker to hold in current · 3/0–5/0 circle hook · mullet or menhaden chunk for redfish and bluefish" },
      { name: "Fixed bottom rig", detail: "Fixed sinker · single strong hook · fish past the outer bar for sharks and bigger black drum" },
    ],
    tip: "Bigger, oilier cut bait pulls redfish, bluefish, and the occasional shark. Fish it past the outer sandbar, not the close-in trough where the smaller stuff bites.",
  },
  fishbites: {
    rigs: [
      { name: "Pompano rig", detail: "Small strip threaded on a long-shank hook · no refrigeration, lasts all day in a pocket" },
    ],
    tip: "Sand Flea and Shrimp flavors fool pompano and whiting well enough — a good backup when bait's scarce or it's too hot to keep the real thing fresh.",
  },
  artificials: {
    rigs: [
      { name: "Doc's Goofy Jig", detail: "1/4–1/2 oz · white or pink · bounced through the trough — the classic pompano jig" },
      { name: "Gotcha Plug", detail: "Fast retrieve past the second bar · Spanish mackerel and bluefish blitzing bait" },
      { name: "Kastmaster / Krocodile Spoon", detail: "3/4–1 oz · long casts · same Spanish mackerel/bluefish pattern" },
      { name: "White bucktail jig", detail: "Steady bottom retrieve · works for whiting and pompano when bait's scarce" },
    ],
    tip: "No bait, no problem: a Doc's Goofy Jig worked through the trough covers pompano and whiting, and a Gotcha plug or spoon covers Spanish mackerel and bluefish when you see bait getting blitzed on the surface.",
  },
};

function BaitPicker() {
  const [selected, setSelected] = useState(["none"]);

  function toggle(id) {
    if (id === "none") { setSelected(["none"]); return; }
    setSelected((prev) => {
      const cleared = prev.filter((x) => x !== "none");
      return cleared.includes(id) ? cleared.filter((x) => x !== id) : [...cleared, id];
    });
  }

  const isNone = selected.includes("none");
  const recs = selected.flatMap((id) => SURF_BAIT_RECS[id]?.rigs || []);
  const tips = [...new Set(selected.map((id) => SURF_BAIT_RECS[id]?.tip).filter(Boolean))];

  return (
    <Collapsible title="🪝 What's In Your Bucket?" defaultOpen={false}>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          {ALL_SURF_BAITS.map((b) => {
            const on = selected.includes(b.id);
            return (
              <button key={b.id} onClick={() => toggle(b.id)} style={{
                padding: "10px 10px", borderRadius: 8, border: on ? "1px solid #5ec8f2" : "1px solid #12314a",
                background: on ? "#0b2a3d" : "#0e2439", cursor: "pointer",
                fontFamily: "'Space Grotesk',sans-serif", textAlign: "left",
                display: "flex", alignItems: "center", gap: 8, transition: "all 0.15s",
              }}>
                <span style={{ fontSize: 22 }}>{b.emoji}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: on ? "#5ec8f2" : "#7fb3d9", lineHeight: 1.3 }}>{b.label}</span>
                {on && <span style={{ marginLeft: "auto", color: "#5ec8f2", fontSize: 16 }}>✓</span>}
              </button>
            );
          })}
        </div>

        {tips.map((tip, i) => (
          <div key={i} style={{ background: "#0b2a3d", border: "1px solid #5ec8f233", borderRadius: 8, padding: "10px 14px", marginBottom: 10, fontSize: 15, color: "#a9dff5", lineHeight: 1.6 }}>
            💡 {tip}
          </div>
        ))}

        {recs.length > 0 ? recs.map((r, i) => (
          <div key={i} style={{ marginBottom: 8, padding: "10px 13px", background: "#0e2439", borderRadius: 8, border: "1px solid #12314a" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#a9c8e0" }}>{r.name}</div>
            <div style={{ fontSize: 15, color: "#7fb3d9", marginTop: 3, lineHeight: 1.55 }}>{r.detail}</div>
          </div>
        )) : isNone ? (
          <div style={{ textAlign: "center", color: "#7fb3d9", fontSize: 15, padding: "16px 0", lineHeight: 1.6 }}>
            No bait or lures — that's fine. Focus on finding the trough (the gutter between sandbars), fish it at first light, and let sand fleas or bait fish tell you where the action is.
          </div>
        ) : (
          <div style={{ textAlign: "center", color: "#7fb3d9", fontSize: 15, padding: "16px 0" }}>Select what you have above to see rigging tips.</div>
        )}
      </div>
    </Collapsible>
  );
}

// ── 3-DAY LOOK AHEAD ─────────────────────────────────────────────────────────
function ForecastStrip({ C, todayScore }) {
  return (
    <Collapsible title="📅 3-Day Look Ahead" defaultOpen>
      <div style={{ marginTop: 12 }}>
        {(C.forecast || []).map((day, i) => {
          const sc = i === 0 ? todayScore : day.fishingScore;
          const color = ratingColor(sc);
          const rating = i === 0 ? surfStatusLabel(C, sc) : ratingLabel(sc);
          const stormColor = day.storms >= 60 ? "#f87171" : day.storms >= 30 ? "#facc15" : "#4ade80";
          return (
            <div key={i} style={{ marginBottom: 10, padding: "14px 14px", background: "#0e2439", borderRadius: 10, border: `1px solid ${color}33` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
                <ScoreRing score={sc} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, color: "#7fb3d9", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>{day.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#eaf5ff", marginBottom: 2 }}>{day.day}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: color }}>{rating}{i === 0 ? "" : " conditions"}</div>
                </div>
                <div style={{ fontSize: 37 }}>{day.emoji}</div>
              </div>
              <div style={{ fontSize: 16, color: "#eaf5ff", marginBottom: 8 }}>{day.headline}</div>
              <div style={{ display: "flex", gap: 14, fontSize: 15, color: "#7fb3d9", marginBottom: 10, flexWrap: "wrap" }}>
                <span>🌡️ {day.high}°/{day.low}°F</span>
                <span>💨 {day.wind}</span>
                <span style={{ color: stormColor }}>⛈️ {day.storms}%</span>
              </div>
              <div style={{ fontSize: 16, color: "#a9c8e0", lineHeight: 1.6, paddingTop: 10, borderTop: "1px solid #12314a" }}>
                💡 {day.aiCall}
              </div>
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}

// ── LOCATION SWITCHER — horizontally-scrollable pill row, one per 30A beach
// in locations.json, geographic (west→east) order. Selection persists to
// localStorage so a returning visitor keeps their pick. ─────────────────────
function LocationSwitcher({ selectedId, onSelect }) {
  return (
    <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, marginBottom: 12, WebkitOverflowScrolling: "touch" }}>
      {LOCATIONS.map((loc) => {
        const active = loc.id === selectedId;
        return (
          <button
            key={loc.id}
            onClick={() => onSelect(loc.id)}
            style={{
              flexShrink: 0,
              background: active ? "#12314a" : "#0e2439",
              border: `1px solid ${active ? "#5ec8f2" : "#12314a"}`,
              borderRadius: 20,
              padding: "7px 14px",
              color: active ? "#eaf5ff" : "#7fb3d9",
              fontSize: 14,
              fontWeight: active ? 700 : 600,
              cursor: "pointer",
              fontFamily: "'Space Grotesk',sans-serif",
              whiteSpace: "nowrap",
            }}
          >
            {loc.name}
          </button>
        );
      })}
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [shared, setShared] = useState(false);
  const [locationId, setLocationId] = useState(() => {
    try {
      const stored = localStorage.getItem(LOCATION_STORAGE_KEY);
      return LOCATIONS.some((l) => l.id === stored) ? stored : DEFAULT_LOCATION_ID;
    } catch {
      return DEFAULT_LOCATION_ID;
    }
  });

  function selectLocation(id) {
    setLocationId(id);
    try { localStorage.setItem(LOCATION_STORAGE_KEY, id); } catch { /* storage unavailable */ }
  }

  const C = buildConditions(locationId);
  const activeLoc = LOCATIONS.find((l) => l.id === locationId) || LOCATIONS.find((l) => l.id === DEFAULT_LOCATION_ID);
  const score = surfScore(C);
  const bestWindow = getBestWindow(C);
  const conditionsDiff = getConditionsDiff(C);
  const avgForecast = averageWeatherForecast(C);
  const surfBiteAge = C.surfBiteSourceDate ? Math.max(0, Math.round((new Date(C.date) - new Date(`${C.surfBiteSourceDate}T12:00:00`)) / 86400000)) : null;

  async function shareReport() {
    const flag = C.beachFlag?.color ? `${C.beachFlag.color} flag` : "flag status unknown";
    const text = `${C.locationName} (30A) Surf Fishing Report — ${C.date}\n${C.weather}\n${flag}${C.beachFlag?.surfHeight ? ` · surf ${C.beachFlag.surfHeight}` : ""}\nScore today: ${score}/10 · ${surfStatusLabel(C, score)}\nBest window: ${bestWindow.startText}–${bestWindow.endText} (${bestWindow.reason})`;
    if (navigator.share) {
      try { await navigator.share({ title: "30A Surf Report", text }); return; } catch { /* cancelled or unsupported */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      setShared(true); setTimeout(() => setShared(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#071624", fontFamily: "'Space Grotesk',sans-serif", color: "#eaf5ff", padding: "20px 16px" }}>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 600, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, letterSpacing: "0.16em", color: "#5ec8f2", textTransform: "uppercase", marginBottom: 3 }}>🏄 Daily Surf Intel</div>
            <h1 style={{ margin: 0, fontSize: 25, fontWeight: 700, color: "#f5faff", lineHeight: 1.2 }}>{C.locationName} · 30A</h1>
            <div style={{ fontSize: 16, color: "#7fb3d9", marginTop: 2 }}>Surf Fishing Report · Walton County, FL · {C.date}</div>
          </div>
          <button onClick={shareReport} style={{ background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "8px 12px", color: "#7fb3d9", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "'Space Grotesk',sans-serif", whiteSpace: "nowrap", flexShrink: 0 }}>
            {shared ? "✓ Copied" : "📤 Share"}
          </button>
        </div>

        {/* Location switcher */}
        <div style={{ marginTop: 14 }}>
          <LocationSwitcher selectedId={locationId} onSelect={selectLocation} />
        </div>

        {/* Beach map */}
        <div style={{ marginTop: 10 }}>
          <BeachMap locationId={locationId} onSelect={selectLocation} />
        </div>

        {/* Beach flag safety banner — before the score, on purpose */}
        <div style={{ marginTop: 12 }}>
          <BeachFlagBanner C={C} />
        </div>

        {/* Surf conditions hero */}
        <div style={{
          position: "relative", marginBottom: 4, textAlign: "center", overflow: "hidden",
          background: "radial-gradient(140% 100% at 50% -10%, #5ec8f222, transparent 60%), #0d2438",
          border: "1px solid #5ec8f266", borderRadius: 16, padding: "22px 18px 18px",
        }}>
          <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 4 }}>🏆 Surf Conditions Today</div>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <ScoreRing score={score} size={156} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: surfStatusColor(C, score), letterSpacing: "0.03em", marginTop: 2 }}>{surfStatusLabel(C, score).toUpperCase()}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", marginTop: 16 }}>
            <div style={{ fontSize: 13, border: "1px solid #12314a", background: "#0e2439", borderRadius: 8, padding: "7px 11px", textAlign: "left" }}>
              <div style={{ fontSize: 11, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>⏰ Best window</div>
              <div style={{ color: "#f5faff", fontWeight: 700 }}>{bestWindow.startText} – {bestWindow.endText}</div>
              <div style={{ fontSize: 11, color: "#a9c8e0", marginTop: 1 }}>{bestWindow.reason}</div>
            </div>
            {C.wave?.height != null && (
              <div style={{ fontSize: 13, border: "1px solid #12314a", background: "#0e2439", borderRadius: 8, padding: "7px 11px", textAlign: "left" }}>
                <div style={{ fontSize: 11, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>🌊 Wave / swell</div>
                <div style={{ color: "#f5faff", fontWeight: 700 }}>{C.wave.height} ft @ {C.wave.period}s</div>
                <div style={{ fontSize: 11, color: "#a9c8e0", marginTop: 1 }}>Swell {C.wave.swellHeight}ft {C.wave.swellDirection} · {C.wave.swellPeriod}s</div>
                <div style={{ fontSize: 10, color: "#4a7396", marginTop: 3 }}>
                  {C.marineSource?.observed === false ? "Model guidance" : "Marine data"} · Open-Meteo
                </div>
              </div>
            )}
          </div>
        </div>

        {conditionsDiff && (
          <div style={{ fontSize: 14, color: "#7fb3d9", padding: "10px 4px", lineHeight: 1.6 }}>
            🔄 {conditionsDiff}
          </div>
        )}

        {/* Side-by-side weather-source comparison. Marine safety values stay
            outside this consensus card because they are different products,
            not interchangeable forecasts. */}
        {C.forecast?.[0] && C.openMeteo?.[0] && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginBottom: 8 }}>
              <div style={{ background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 5 }}>NWS (official)</div>
                <div style={{ fontSize: 16, color: "#eaf5ff", fontWeight: 600 }}>{C.forecast[0].high}°F · {C.forecast[0].storms}% storms</div>
                <div style={{ fontSize: 14, color: "#7fb3d9", marginTop: 2 }}>{C.forecast[0].wind}</div>
                {C.waterTemp && <div style={{ fontSize: 14, color: "#7fb3d9", marginTop: 2 }}>🌊 Gulf model SST {C.waterTemp}°F</div>}
              </div>
              <div style={{ background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 5 }}>Open-Meteo</div>
                <div style={{ fontSize: 16, color: "#eaf5ff", fontWeight: 600 }}>{C.openMeteo[0].high}°F · {C.openMeteo[0].stormChance}% storms</div>
                <div style={{ fontSize: 14, color: "#7fb3d9", marginTop: 2 }}>{C.openMeteo[0].windDir} {C.openMeteo[0].windSpeed} mph</div>
                {C.waterTemp && <div style={{ fontSize: 14, color: "#7fb3d9", marginTop: 2 }}>🌊 Gulf model SST {C.waterTemp}°F</div>}
              </div>
            </div>
            {avgForecast.sourceCount === 2 && (
              <div style={{ background: "#0b2a3d", border: "1px solid #5ec8f266", borderRadius: 8, padding: "11px 14px", marginBottom: 10, textAlign: "center" }}>
                <div style={{ fontSize: 13, color: "#5ec8f2", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Weather consensus (2 sources)</div>
                <div style={{ fontSize: 16, color: "#eaf5ff", fontWeight: 600 }}>{avgForecast.high}°F · {avgForecast.storms}% storms</div>
              </div>
            )}
            <div style={{ background: "#0b2a3d", border: "1px solid #5ec8f266", borderRadius: 8, padding: "11px 14px", fontSize: 15, color: "#a9dff5", marginBottom: 12, lineHeight: 1.55 }}>
              {C.stormChance >= 30 ? "⛈️" : C.stormChance >= 10 ? "⛅" : "🌞"} {C.date.split(",")[0]}: {C.stormChance >= 10
                ? `${C.stormChance}% chance of showers/storms${C.stormWindow ? `, ${C.stormWindow}` : ""} — favor an early trip and watch the radar. `
                : "No meaningful storm threat in the NWS forecast. "}{C.weather}
            </div>
          </>
        )}

        {/* Live radar */}
        <RadarPanel lat={activeLoc.lat} lon={activeLoc.lon} locationName={activeLoc.name} />

        {/* Weather + wind + water temp */}
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220, background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 12 }}>
            <WindCompass dir={C.wind.dir} />
            <div>
              <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Wind</div>
              <div style={{ fontSize: 15, color: "#f5faff", fontWeight: 700 }}>{C.wind.description}</div>
              <div style={{ fontSize: 13, color: "#7fb3d9" }}>{windSurfNote(C.wind.dir)}</div>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 140, background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>Weather</div>
            <div style={{ fontSize: 15, color: "#f5faff" }}>{C.weather}</div>
          </div>
          {C.waterTemp && (
            <div style={{ flex: 1, minWidth: 140, background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>🌊 Water temp</div>
              <div style={{ fontSize: 15, color: "#f5faff" }}>{C.waterTemp}°F</div>
            </div>
          )}
          <div style={{ flex: 1, minWidth: 140, background: "#0e2439", border: "1px solid #12314a", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 13, color: "#7fb3d9", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>🌙 Moon</div>
            <div style={{ fontSize: 15, color: "#f5faff" }}>{C.moonPhase}</div>
          </div>
          <SunCountdown sunrise={C.sunrise} sunset={C.sunset} />
        </div>

        {/* Tide curve */}
        <Collapsible title="📈 Tide" defaultOpen>
          <div style={{ marginTop: 10 }}>
            <TideCurve events={C.tideEvents} sunrise={C.sunrise} sunset={C.sunset} stormWindow={C.stormWindow} stormChance={C.stormChance} />
            <div style={{ fontSize: 14, color: "#7fb3d9", textAlign: "center", marginTop: 6 }}>{C.tide}</div>
          </div>
        </Collapsible>

        {/* 3-day look ahead */}
        <ForecastStrip C={C} todayScore={score} />

        {/* Surf bite report */}
        <div style={{ background: "#0e2439", border: "1px solid #12314a", borderRadius: 10, padding: "13px 16px", marginBottom: 4 }}>
          <div style={{ fontSize: 16, color: "#7fb3d9", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontWeight: 600 }}>🎣 What's Being Caught — Local Reports</div>
          <p style={{ margin: "0 0 6px 0", fontSize: 16, color: "#eaf5ff", lineHeight: 1.7 }}>{C.surfBiteReport}</p>
          {C.surfBiteSource && (
            <div style={{ fontSize: 15, color: "#7fb3d9", fontStyle: "italic" }}>
              {C.surfBiteSourceUrl ? <a href={C.surfBiteSourceUrl} target="_blank" rel="noreferrer" style={{ color: "#7fb3d9" }}>{C.surfBiteSource}</a> : C.surfBiteSource}
            </div>
          )}
          {C.surfBiteSourceKind === "social" && (
            <div style={{ fontSize: 13, color: "#8fb8d5", marginTop: 4 }}>Public Reel30A social post · direct link and publication date required</div>
          )}
          {surfBiteAge != null && (
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6, color: surfBiteAge > 14 ? "#f87171" : surfBiteAge > 7 ? "#facc15" : "#7fb3d9" }}>
              {surfBiteAge === 0 ? "Source published today" : `Source published ${surfBiteAge} day${surfBiteAge === 1 ? "" : "s"} ago`}
            </div>
          )}
        </div>

        <div style={{ height: 14 }} />

        {/* Reading the surf tip */}
        <Collapsible title="📖 Reading the Surf" defaultOpen={false}>
          <div style={{ fontSize: 16, color: "#eaf5ff", lineHeight: 1.7, paddingTop: 10 }}>{C.readingTheSurf}</div>
        </Collapsible>

        {/* Bait / rig picker */}
        <BaitPicker />

        {/* Access */}
        <div style={{ background: "#0e2439", border: "1px solid #12314a", borderRadius: 10, padding: "13px 16px", marginBottom: 10 }}>
          <div style={{ fontSize: 16, color: "#7fb3d9", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontWeight: 600 }}>🏖️ Beach Access</div>
          <div style={{ fontSize: 16, color: "#eaf5ff", lineHeight: 1.7 }}>{C.access}</div>
        </div>

        {/* Regulations */}
        <div style={{ background: "#0e2439", border: "1px solid #12314a", borderRadius: 10, padding: "13px 16px", marginBottom: 10 }}>
          <div style={{ fontSize: 16, color: "#7fb3d9", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8, fontWeight: 600 }}>📋 Regulations</div>
          {C.regulations.map(r => (
            <div key={r.species} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", borderBottom: "1px solid #12314a", gap: 10 }}>
              <span style={{ fontSize: 16, fontWeight: 600, color: "#a9c8e0", flexShrink: 0 }}>{r.species}</span>
              <span style={{ fontSize: 15, color: "#eaf5ff", textAlign: "right" }}>{r.rules}</span>
            </div>
          ))}
        </div>

        <div style={{ height: 36 }} />
        <div style={{ textAlign: "center", fontSize: 16, color: "#7fb3d9", lineHeight: 1.7 }}>
          Weather: NWS · waves: Open-Meteo model · tides: NOAA · flag: Visit South Walton/SWFD<br />
          Always verify posted flags and conditions before entering the water<br />{C.lastUpdated}
        </div>
      </div>
    </div>
  );
}
