# 30A Surf Report

A daily surf fishing conditions app for Grayton Beach, FL (30A) — the flagship spot for what's meant to grow into coverage of the Sandestin-to-Panama-City-Beach corridor. Forked from the same pipeline as [331 Bridge Fishing Report](https://github.com/djblackjr/331-fishing-report), Danny's bay-fishing app for Freeport, FL — same architecture, different water.

## What this is
- React + Vite single-page app, one flagship location for now (Grayton Beach)
- Main component: `src/App.jsx`
- Deploys to GitHub Pages via `.github/workflows/deploy-pages.yml` on every push to `main`

## What makes this different from the bay app
- **Wave/swell data** (Open-Meteo Marine API) — a bay has no meaningful surf; this is the one genuinely new data category.
- **Beach flag safety status** — green/yellow/red/double-red + rip current risk, checked daily via Claude + web search (no free structured API exists for this). Shown *above* the score, since whether the water's legally/safely open matters before "how good is the bite."
- **Two separate NWS offices**: Grayton Beach sits in NWS Tallahassee's territory; Destin (if/when that gets added) is NWS Mobile's. The `api.weather.gov/points` lookup handles this automatically — no hardcoded office.
- **No dedicated NOAA tide station on 30A itself** — this uses Destin East Pass (station 8729511), the nearest gauge, same as the bay app already does.

## Daily data pipeline
Three scripts, run in order by `.github/workflows/daily-refresh.yml`:
1. `scripts/update-conditions.mjs` — NWS forecast, NOAA tides, Open-Meteo (2nd forecast source + wave/swell), moon phase. Free, no API key. (Yr.no was tried as a 3rd source and dropped — see the bay app's README for why.)
2. `scripts/update-surf-safety.mjs` — beach flag color + rip current risk, via Claude + web search. Needs `ANTHROPIC_API_KEY`.
3. `scripts/update-surf-report.mjs` — local surf bite report (pompano/whiting/redfish chatter), via Claude + web search. Needs `ANTHROPIC_API_KEY`.

Run any of them manually:
```bash
node scripts/update-conditions.mjs
node --env-file=.env scripts/update-surf-safety.mjs
node --env-file=.env scripts/update-surf-report.mjs
```

## Setup
```bash
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm install
npm run dev             # local preview
npm run build            # production build
```

## Not done yet
This is a narrow first slice, deliberately — see the "how should I start this" conversation that produced it:
- **No GitHub repo created yet.** This only exists locally. Once it looks right, create `djblackjr/30a-surf-report` on GitHub, push, then set the `ANTHROPIC_API_KEY` and `DEPLOY_TOKEN` repo secrets (same PAT-dispatch pattern as the bay app — see `daily-refresh.yml`'s comments for why `DEPLOY_TOKEN` is needed instead of the default token).
- **No PWA/offline support** — intentionally skipped for this first pass to keep scope tight. Port it from the bay app if/when wanted (and note: the bay app's own `public/sw.js` currently has a real bug — some stray pasted text above the actual code — worth fixing there before copying the pattern here).
- **Only one location.** Destin and Panama City Beach were deliberately deferred — adding them means handling two NWS offices and two separate beach-flag systems (South Walton vs. Bay County) instead of one.
- **No visual/brand redesign** — reuses the bay app's card language with a blue/navy palette swap, nothing more considered than that yet.
