# CityShield

**Real-time utility outage alerts for Varna, Bulgaria.**

CityShield keeps residents informed about power, water, heating, and transport
disruptions across the city. It continuously monitors official sources — utility
companies, local authorities, and infrastructure agencies — parses each
announcement, works out the affected area, and delivers location-aware push
notifications together with an interactive map of every active incident.

The entire server side runs as a **single TypeScript Cloudflare Worker** on
Cloudflare's free plan. A React Native app is the client.

- **[SPEC.md](SPEC.md)** — the system specification: how every part works, and why.
- **[TODO.md](TODO.md)** — what is left before a Play Store release, and the operator
  setup checklist (§7).

---

## Features

- **Real-time alerts** — outage reports are collected directly from official
  channels and pushed to affected users shortly after publication.
- **Location-aware notifications** — users set their location once; each incident
  is geocoded and only users inside the affected area are notified.
- **Interactive map** — every active incident is drawn as a precise polygon of the
  affected zone over OpenStreetMap tiles.
- **Category preferences** — users choose which categories they care about (water,
  power, heating, traffic).
- **Bus-line subscriptions** — public-transport users can follow specific bus lines
  and be notified only about disruptions affecting them.
- **Trusted data only** — information comes exclusively from official sources.

## Data sources

| Category | Source |
|---|---|
| Water supply | ViK Varna (vikvarna.com) — breakdowns and planned repairs, across the whole municipality |
| Electricity | Energo-Pro / ERP Sever (erpsever.bg) |
| District heating | Veolia Energy Varna (energy-varna.bg) |
| Public transport & traffic | VarnaTraffic (varnatraffic.com) |

## Architecture

The server side is one Worker with two entry points — an HTTP API (`fetch`) and a
scheduled ingestion pipeline (Cron Triggers) — sharing one D1 database, one
Workers-AI binding, and one push client.

```
                        ┌───────────────────────── backend/ (Cloudflare Worker) ──────────────────────────┐
                        │                                                                                 │
  official sources ───► │  scheduled() every 15 min                        fetch()  (Hono router)         │
  (ViK, ERP Sever,      │   scrape (cheerio) → parse (Workers AI, JSON     ┌──────────────────────────┐   │
   Veolia, VarnaTraffic)│   schema) → geocode (Nominatim) → build polygon  │ /api/auth  /api/alerts   │   │ ◄── React Native app
                        │   (Overpass + JSTS) → store → match users →      │ /api/preferences /privacy│   │      (frontend/)
                        │   notify (OneSignal)                             │                          │   │
                        │                        │                         └──────────────────────────┘   │
                        │                        └──────────────► Cloudflare D1 (SQLite) ◄────────────────┘
                        │                                          Workers AI · OneSignal                 │
                        └─────────────────────────────────────────────────────────────────────────────────┘
```

- **Ingestion** (`backend/src/ingestion/`) — the `scheduled` handler runs every 15
  minutes (plus a daily cleanup). One module per source scrapes new announcements,
  Workers AI parses them into structured data in JSON-schema mode, Nominatim
  geocodes them, and an Overpass + [JSTS](https://github.com/bjornharrtell/jsts)
  pipeline turns the affected streets into a polygon. Crawl state lives in D1, and
  the cursor semantics guarantee an alert is delayed rather than lost or duplicated.
- **API** (`backend/src/api/`) — a [Hono](https://hono.dev) router handling JWT
  auth with rotating refresh-token sessions, user location, alert retrieval for the
  map/feed, and per-category + bus-line notification preferences. It also serves
  email verification and password reset, a GDPR data-export / account-deletion
  flow, and the privacy policy.
- **Core** (`backend/src/core/`) — shared logic: alert store-and-notify, trigram
  fuzzy street matching (a `pg_trgm` port), geometry helpers, the geocoding cache,
  PBKDF2 passwords, HS256 JWTs, session tokens, the OneSignal push client, and the
  bus-line catalog.
- **Mobile app** (`frontend/`) — a React Native Android app with an
  OpenStreetMap-based incident map (Leaflet in a WebView), an alert feed, a
  notification inbox synced from the alert feed, per-category settings,
  Bulgarian/English UI, dark mode, and OneSignal push.

## Technology stack

| Component | Technologies |
|---|---|
| Backend | Cloudflare Workers, TypeScript, Hono, D1 (SQLite), Workers AI (`@cf/qwen/qwen3-30b-a3b-fp8`, JSON-schema mode), Cron Triggers, Rate Limiting bindings, cheerio, JSTS, Zod, Nominatim & Overpass geocoding, OneSignal |
| Mobile app | React Native 0.85, React 19, React Navigation, Leaflet in a WebView (OpenStreetMap tiles), OneSignal |
| Tooling | Wrangler, Vitest (`@cloudflare/vitest-pool-workers`), GitHub Actions |

## Repository layout

```
CityShield/
├── backend/                  Cloudflare Worker — the entire server side
│   ├── wrangler.jsonc        Bindings, cron triggers, vars
│   ├── migrations/           D1 SQL migrations (0001–0014)
│   ├── seeds/                regions/streets seed data + generator
│   ├── src/
│   │   ├── index.ts          Exports { fetch, scheduled }
│   │   ├── api/              Hono routes (auth, alerts, preferences, privacy) + rate limiting
│   │   ├── core/             Alert service, fuzzy + place-name match, geo, geocoding, onesignal, jwt, tokens, password
│   │   └── ingestion/        Scheduled pipeline + one module per source
│   ├── test/                 Vitest suite (runs against local D1)
│   └── spikes/               Phase 0 de-risking spikes + RESULTS.md
├── frontend/                 React Native Android app (see frontend/SETUP.md)
├── tools/
│   ├── osm-seed-builder/     Local UI that builds the seed data from Overpass
│   └── push-tester/          Local UI that fires a test push at one user or everyone
├── setup.bat                 Windows: install deps for frontend and/or backend
├── SPEC.md                   System specification (architecture, contracts, GDPR, ops)
├── TODO.md                   Remaining work before release + operator setup checklist
└── COMPLIANCE.md             GDPR record (Play Data Safety, DPIA, breach runbook)
```

## Getting started

### Prerequisites

| Requirement | Used by |
|---|---|
| [Node.js](https://nodejs.org/) 22+ | Backend & app tooling |
| A [Cloudflare](https://dash.cloudflare.com) account (free plan) | Backend — D1, Workers AI, deploys |
| [Android Studio](https://developer.android.com/studio) (or a device) | Mobile app |
| A [OneSignal](https://onesignal.com) app (free plan) | Push notifications |

See [TODO.md](TODO.md) §7 for the exact accounts, secrets, and one-time provisioning
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

Local secrets go in `backend/.dev.vars` (copy `backend/.dev.vars.example`); config
and non-secret vars live in [backend/wrangler.jsonc](backend/wrangler.jsonc).

"Local" describes where the code runs, not where the side effects go: `wrangler
dev` makes real Workers AI calls (which consume neurons) and can send real pushes.

The region and street reference data comes from OpenStreetMap. To add or refresh
it, run the seed builder and follow
[tools/osm-seed-builder/README.md](tools/osm-seed-builder/README.md):

```sh
python tools/osm-seed-builder/app.py
```

It builds into its own gitignored `output/` directory and applies to D1 from
there; `backend/seeds/` changes only when you press its dedicated merge button.

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

- **Backend** — from `backend/`: `npm test` (Vitest against a local D1 — 204 tests
  across 19 files). Type-check with
  `npx tsc -p tsconfig.json && npx tsc -p test/tsconfig.json`.
- **Mobile app** — from `frontend/`: `npm run lint` and `npm run typecheck`.

The same checks run in GitHub Actions
([.github/workflows/ci.yml](.github/workflows/ci.yml)) on every push and pull
request, which also does a `wrangler deploy --dry-run` bundle-size check.

## API overview

All routes are registered in [backend/src/api/app.ts](backend/src/api/app.ts); the
full contract, including status codes and DTO shapes, is [SPEC.md](SPEC.md) §1.4.

| Route group | Responsibility |
|---|---|
| `/api/auth` | Registration, login, JWT + refresh-token sessions, `me`, user location (reverse-geocoded + fuzzy region/street match), email verification, password reset, GDPR export & account deletion |
| `/api/alerts` | Alert retrieval for the map/feed (`recent`, with coordinates and polygons), API-key-protected ingestion, and a push-delivery test hook |
| `/api/preferences` | Per-category notification settings and bus-line subscriptions |
| `/privacy` | Published privacy policy (GDPR), Bulgarian and English |

## Deployment

The Worker deploys with Wrangler; TLS and scaling are handled by Cloudflare.
Remote D1 and secrets must be provisioned first — see [TODO.md](TODO.md) §7 and
[SPEC.md](SPEC.md) §3.3.

Currently live at `https://cityshield.cityshield-varna.workers.dev` (D1 in `weur`,
crons every 15 min + a daily cleanup).

```sh
cd backend
npm run db:remote                     # apply migrations + seed the remote D1
npx wrangler secret put JWT_KEY       # + INGEST_API_KEY, ONESIGNAL_API_KEY
npx wrangler deploy
```

Pushes to `main` deploy automatically via GitHub Actions once the
`CLOUDFLARE_API_TOKEN` repo secret is set. Development currently happens on the
`cloudflare-migration` branch, and `main` still holds the retired pre-Cloudflare
stack — merging it forward is a prerequisite for CI deploys ([TODO.md](TODO.md)).

## Further documentation

| Document | Contents |
|---|---|
| [SPEC.md](SPEC.md) | System specification — architecture, data model, API contract, ingestion, GDPR, operations |
| [TODO.md](TODO.md) | Remaining work before release; §7 is the operator setup — accounts, secrets, provisioning |
| [COMPLIANCE.md](COMPLIANCE.md) | GDPR record — Play Data Safety answers, DPIA/DPO reasoning, breach runbook |
| [frontend/SETUP.md](frontend/SETUP.md) | Mobile app development environment |
| [tools/osm-seed-builder/README.md](tools/osm-seed-builder/README.md) | Building the regions/streets reference data from OSM |
| [tools/push-tester/README.md](tools/push-tester/README.md) | End-to-end push delivery testing |
| [backend/spikes/RESULTS.md](backend/spikes/RESULTS.md) | Phase 0 de-risking spike findings |

CityShield's pre-Cloudflare stack (Python ingestion + ASP.NET Core API +
PostgreSQL/PostGIS + self-hosted Ollama) is described in [SPEC.md](SPEC.md) §4.
Its source was deleted from the working tree and remains in git history
(`git log --all -- backend_deprecated/`, last present at commit `026f562`).
