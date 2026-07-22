# CityShield

**Real-time utility outage alerts for Varna, Bulgaria.**

CityShield keeps residents informed about power, water, heating, and road
disruptions across the city. It continuously monitors official sources — utility
companies, local authorities, and infrastructure agencies — parses each
announcement, works out the affected area, and delivers location-aware push
notifications together with an interactive map of every active incident.

The entire server side runs as a **single TypeScript Cloudflare Worker** on
Cloudflare's free plan. A React Native app is the client.

> **History:** CityShield previously ran on a Python ingestion service + an
> ASP.NET Core API + PostgreSQL/PostGIS + self-hosted Ollama. That stack has been
> replaced and now lives, unmaintained, in [`backend_deprecated/`](backend_deprecated/) — see
> [`backend_deprecated/DEPRECATED.md`](backend_deprecated/DEPRECATED.md). The migration is recorded
> in [PLAN.MD](PLAN.MD) and [TODO.md](TODO.md).

---

## Features

- **Real-time alerts** — outage reports are collected directly from official
  channels and pushed to affected users shortly after publication.
- **Location-aware notifications** — users set their location once; each incident
  is geocoded and only users inside the affected area are notified.
- **Interactive map** — every active incident is drawn as a precise polygon of the
  affected zone over OpenStreetMap tiles.
- **Category preferences** — users choose which categories they care about (power,
  water, heating, traffic).
- **Bus-line subscriptions** — public-transport users can follow specific bus lines
  and be notified only about disruptions affecting them.
- **Trusted data only** — information comes exclusively from official sources.

## Data sources

| Category | Source |
|---|---|
| Water supply | ViK Varna (vikvarna.com) |
| Electricity | Energo-Pro / ERP Sever (erpsever.bg) |
| District heating | Veolia Energy Varna (energy-varna.bg) |
| Public transport & traffic | VarnaTraffic (varnatraffic.com) |

## Architecture

The server side is one Worker with two entry points — an HTTP API (`fetch`) and a
scheduled ingestion pipeline (Cron Triggers) — sharing one D1 database, one
Workers-AI binding, and one push client.

```
                        ┌───────────────────────── backend/ (Cloudflare Worker) ─────────────────────────┐
                        │                                                                                 │
  official sources ───► │  scheduled() every 15 min                        fetch()  (Hono router)         │
  (ViK, ePro, Veolia,   │   scrape (cheerio) → parse (Workers AI, JSON     ┌─────────────────────────┐    │
   VarnaTraffic, API)   │   schema) → geocode (Nominatim) → build polygon  │ /api/auth  /api/alerts   │    │ ◄── React Native app
                        │   (Overpass + JSTS) → store → match users →      │ /api/prefs  /privacy     │    │      (frontend/)
                        │   notify (OneSignal)                             │                          │    │
                        │                        │                         └─────────────────────────┘    │
                        │                        └──────────────► Cloudflare D1 (SQLite) ◄────────────────┘
                        │                                          Workers AI · OneSignal                 │
                        └─────────────────────────────────────────────────────────────────────────────────┘
```

- **Ingestion** (`backend/src/ingestion/`) — the `scheduled` handler runs every 15
  minutes (plus a daily cleanup). One module per source scrapes new announcements,
  Workers AI parses them into structured data in JSON-schema mode, Nominatim
  geocodes them, and an Overpass + [JSTS](https://github.com/bjornharrtell/jsts)
  pipeline turns the affected streets into a polygon. Crawl state lives in D1.
- **API** (`backend/src/api/`) — a [Hono](https://hono.dev) router handling JWT
  auth and user location, alert retrieval for the map/feed, and per-category +
  bus-line notification preferences. It also serves a GDPR data
  export / account-deletion flow and the privacy policy.
- **Core** (`backend/src/core/`) — shared logic: alert store-and-notify, trigram
  fuzzy street matching (a `pg_trgm` port), geometry helpers, the geocoding cache,
  PBKDF2 passwords, HS256 JWTs, the OneSignal push client, and the bus-line
  catalog.
- **Mobile app** (`frontend/`) — a React Native Android app with an
  OpenStreetMap-based incident map (Leaflet in a WebView), an alert feed, a
  notification inbox synced from the alert feed, per-category settings,
  Bulgarian/English UI, and OneSignal push.

## Technology stack

| Component | Technologies |
|---|---|
| Backend | Cloudflare Workers, TypeScript, Hono, D1 (SQLite), Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`, JSON-schema mode), Cron Triggers, cheerio, JSTS, Zod, Nominatim & Overpass geocoding, OneSignal |
| Mobile app | React Native 0.85, React 19, React Navigation, Leaflet in a WebView (OpenStreetMap tiles), OneSignal |
| Tooling | Wrangler, Vitest (`@cloudflare/vitest-pool-workers`), GitHub Actions |

## Repository layout

```
CityShield/
├── backend/                  Cloudflare Worker — the entire server side
│   ├── wrangler.jsonc        Bindings, cron triggers, vars
│   ├── migrations/           D1 SQL migrations
│   ├── seeds/                regions/streets seed data + generator
│   ├── src/
│   │   ├── index.ts          Exports { fetch, scheduled }
│   │   ├── api/              Hono routes (auth, alerts, tokens, preferences, privacy)
│   │   ├── core/             Alert service, fuzzy match, geo, geocoding, onesignal, jwt, password
│   │   └── ingestion/        Scheduled pipeline + one module per source
│   ├── test/                 Vitest suite (runs against local D1)
│   └── spikes/               Phase 0 de-risking spikes + RESULTS.md
├── frontend/                 React Native Android app (see frontend/SETUP.md)
├── tools/
│   ├── osm-seed-builder/     Local UI that builds the seed data from Overpass
│   └── push-tester/          Local UI that fires a test push at one user or everyone
├── backend_deprecated/       Old pre-Cloudflare stack — do not use (see DEPRECATED.md)
├── setup.bat                 Windows: install deps for frontend and/or backend
├── PLAN.MD                   Cloudflare migration plan (design spec)
├── TODO.md                   Migration checklist / status
└── SETUP.md                  Operator setup checklist (accounts & secrets)
```

## Getting started

### Prerequisites

| Requirement | Used by |
|---|---|
| [Node.js](https://nodejs.org/) 22+ | Backend & app tooling |
| A [Cloudflare](https://dash.cloudflare.com) account (free plan) | Backend — D1, Workers AI, deploys |
| [Android Studio](https://developer.android.com/studio) (or a device) | Mobile app |
| A [OneSignal](https://onesignal.com) app (free plan) | Push notifications |

See [SETUP.md](SETUP.md) for the exact accounts, secrets, and one-time provisioning
the operator needs to supply.

On Windows, **`setup.bat`** in the repo root installs the npm packages for both
sides and checks the Android toolchain; it asks what to set up and whether to use
Docker (default: no). The manual equivalents are below.

### 1. Run the backend locally

```sh
cd backend
npm install
npm run db:local     # apply D1 migrations + generate & load the seed data
npm run dev          # wrangler dev — serves the Worker on http://localhost:8787
```

The region and street reference data comes from OpenStreetMap. To add or refresh
it, run the seed builder and follow
[tools/osm-seed-builder/README.md](tools/osm-seed-builder/README.md):

```sh
python tools/osm-seed-builder/app.py
```

It builds into its own gitignored `output/` directory and applies to D1 from
there; `backend/seeds/` changes only when you press its dedicated merge button.

Local secrets go in `backend/.dev.vars` (copy `backend/.dev.vars.example`); config
and non-secret vars live in [backend/wrangler.jsonc](backend/wrangler.jsonc).

To check that push delivery actually works — Worker → OneSignal → phone — run the
push tester and follow [tools/push-tester/README.md](tools/push-tester/README.md):

```sh
python tools/push-tester/app.py
```

It drives `POST /api/alerts/test-push` against the local or the deployed Worker,
addressing one user or every registered user. No alert is stored, so a test push
never shows up in the app's feed.

### 2. Run the mobile app

Follow **[frontend/SETUP.md](frontend/SETUP.md)** — a step-by-step guide covering the
Android emulator/device, OneSignal configuration, and what to run after each kind of
change. Point the app's `CITYSHIELD_API_URL` at your `wrangler dev` host (or the
deployed Worker).

The short version on Windows: `frontend\build-apk.bat` builds a standalone
release APK against the deployed Worker and needs no arguments.

## Running the tests

- **Backend** — from `backend/`: `npm test` (Vitest against a local D1). Type-check
  with `npx tsc -p tsconfig.json && npx tsc -p test/tsconfig.json`.
- **Mobile app** — from `frontend/`: `npm run lint` and `npm run typecheck`.

The same checks run in GitHub Actions
([.github/workflows/ci.yml](.github/workflows/ci.yml)) on every push and pull
request, which also does a `wrangler deploy --dry-run` bundle-size check.

## API overview

All routes are registered in [backend/src/api/app.ts](backend/src/api/app.ts).

| Route group | Responsibility |
|---|---|
| `/api/auth` | Registration, login, JWT issuance, `me`, user location (reverse-geocoded + fuzzy region/street match), GDPR export & account deletion |
| `/api/alerts` | Alert retrieval for the map/feed (`recent`, with coordinates and polygons) and API-key-protected ingestion |
| `/api/preferences` | Per-category notification settings and bus-line subscriptions |
| `/privacy` | Published privacy policy (GDPR) |

## Deployment

The Worker deploys with Wrangler; TLS and scaling are handled by Cloudflare. Remote
D1 and secrets must be provisioned first — see [SETUP.md](SETUP.md) and
[PLAN.MD](PLAN.MD) §3.

Currently live at `https://cityshield.cityshield-varna.workers.dev` (D1 in `weur`,
crons every 15 min + a daily cleanup). The Android app is **not** yet rebuilt against
OneSignal, so there are no push subscribers yet — see [TODO.md](TODO.md) Phase 5.

```sh
cd backend
npm run db:remote                     # apply migrations + seed the remote D1
npx wrangler secret put JWT_KEY       # + INGEST_API_KEY, ONESIGNAL_API_KEY
npx wrangler deploy
```

Pushes to `main` deploy automatically via GitHub Actions once the
`CLOUDFLARE_API_TOKEN` repo secret is set.

## Further documentation

| Document | Contents |
|---|---|
| [PLAN.MD](PLAN.MD) | Full Cloudflare migration plan and backend design spec |
| [TODO.md](TODO.md) | Migration checklist and current status |
| [SETUP.md](SETUP.md) | Operator setup — accounts, secrets, provisioning |
| [frontend/SETUP.md](frontend/SETUP.md) | Mobile app development environment |
| [backend/spikes/RESULTS.md](backend/spikes/RESULTS.md) | Phase 0 de-risking spike findings |
| [backend_deprecated/DEPRECATED.md](backend_deprecated/DEPRECATED.md) | The retired pre-Cloudflare stack |
