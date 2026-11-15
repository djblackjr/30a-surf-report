# 30A Surf Report

A daily surf fishing conditions app for Grayton Beach, FL (30A) — the flagship spot for what's meant to grow into coverage of the Sandestin-to-Panama-City-Beach corridor. Forked from the same pipeline as [331 Bridge Fishing Report](https://github.com/djblackjr/331-fishing-report), Danny's bay-fishing app for Freeport, FL — same architecture, different water.

## What this is
- React + Vite single-page app, one flagship location for now (Grayton Beach)
- Main component: `src/App.jsx`
- Deploys to GitHub Pages via `.github/workflows/deploy-pages.yml` on every push to `main`

## What makes this different from the bay app
- **Wave/swell model data** (Open-Meteo Marine API) — coordinate-based model guidance, not a sensor installed at each beach. The UI labels it accordingly and records its valid/fetch time and returned grid point.
- **Beach flag safety status** — the official green/yellow/red/double-red flag is read from Visit South Walton's SWFD-fed widget; rip-current risk and surf height come directly from the latest NWS Tallahassee Surf Zone Forecast (`SRF`, South Walton zone `FLZ108`). No LLM is used for safety data.
- **Two separate NWS offices**: Grayton Beach sits in NWS Tallahassee's territory; Destin (if/when that gets added) is NWS Mobile's. The `api.weather.gov/points` lookup handles this automatically — no hardcoded office.
- **No dedicated NOAA tide station on 30A itself** — this uses Destin East Pass (station 8729511), the nearest gauge, same as the bay app already does.

## Daily data pipeline
Three scripts, run in order by `.github/workflows/daily-refresh.yml`:
1. `scripts/update-conditions.mjs` — NWS forecast, NOAA tides, Open-Meteo (2nd forecast source + wave/swell), moon phase. Free, no API key. (Yr.no was tried as a 3rd source and dropped — see the bay app's README for why.)
2. `scripts/update-surf-safety.mjs` — official beach flag plus the latest NWS rip-current risk and surf height. Free, deterministic, no API key.
3. `scripts/update-surf-report.mjs` — latest Northwest Florida Fishing Report podcast episode (title, date, link, and the publisher's own episode notes) from its public RSS feed, if published within 14 days; otherwise the app says no current report is available. Free, no API key. Reel30A's Facebook/Instagram (login-walled) and Half Hitch's blog (Cloudflare bot protection) can't be read by a script, so the app links to them instead. This step used Claude + web search until Nov 2026; it was replaced to eliminate API charges.

Run any of them manually:
```bash
node scripts/update-conditions.mjs
node scripts/update-surf-safety.mjs
node scripts/update-surf-report.mjs
```

## Setup
```bash
npm install
npm run dev             # local preview
npm run build            # production build
```

## Data provenance and limits
- Open-Meteo Marine values are model output for the model grid cell nearest each coordinate. Nearby beaches may resolve to the same grid cell, and local sandbars/shorebreak can differ from the model.
- NWS `FLZ108` is a South Walton zone forecast, not a separate forecast for every access point.
- The official Walton County flag is countywide. Always follow the physical flag and lifeguards at the beach; the app is not a substitute for an on-site safety decision.
- No paid APIs are used. The fishing-report card shows the podcast publisher's own notes verbatim (excerpted, attributed), and they cover the whole Emerald Coast, not just 30A.

## Not done yet
This is a narrow first slice, deliberately — see the "how should I start this" conversation that produced it:
- **External cron trigger.** The repo is live on GitHub with the `DEPLOY_TOKEN` secret (same PAT-dispatch pattern as the bay app — see `daily-refresh.yml`'s comments). It still relies on GitHub's native schedule; the cron-job.org fallback the bay app uses isn't set up yet.
- **No PWA/offline support** — intentionally skipped for this first pass to keep scope tight. Port it from the bay app if/when wanted (and note: the bay app's own `public/sw.js` currently has a real bug — some stray pasted text above the actual code — worth fixing there before copying the pattern here).
- **Only one location.** Destin and Panama City Beach were deliberately deferred — adding them means handling two NWS offices and two separate beach-flag systems (South Walton vs. Bay County) instead of one.
- **No visual/brand redesign** — reuses the bay app's card language with a blue/navy palette swap, nothing more considered than that yet.
