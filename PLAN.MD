# CityShield → Cloudflare Migration Plan

**Goal:** replace the two server-side components (`backend/` Python ingestion + `ASP/` ASP.NET Core API) with a **single TypeScript Cloudflare Worker**, running entirely on Cloudflare's free plan:

| Today | Tomorrow |
|---|---|
| PostgreSQL + PostGIS (planned: Neon) | **Cloudflare D1** (SQLite) |
| Ollama (qwen3.5, self-hosted) | **Workers AI** (free models, JSON mode) |
| ASP.NET Core 8 API on a VM/container | **Worker `fetch` handler** (Hono router) |
| Python asyncio polling loops | **Worker `scheduled` handler** (Cron Triggers) |
| Python → API over HTTP (`X-Api-Key`) | **Direct function calls** inside one Worker |
| Firebase Admin SDK | **OneSignal REST API** (§1.6; originally FCM HTTP v1 direct) |
| docker-compose + reverse proxy + TLS setup | **`wrangler deploy`** (TLS automatic) |

The React Native app, the Firebase project, and the five data sources stay as they are. The mobile app only needs a new `CITYSHIELD_API_URL` (plus one new screen for GDPR account deletion, see §1.10).

**Why a single Worker:** the ingestion service's only consumer is the API, and the API's fuzzy-matching tables are seeded by the ingestion side. Merging them removes the `ASP_API_URL`/`ASP_API_KEY` HTTP hop, halves the code to maintain, and lets both halves share one D1 database, one geocoding cache, and one push client.

**Verified free-tier numbers this plan is built around** (as of July 2026 — re-check before implementation, links in §3.6):

- Workers Free: 100,000 requests/day, **10 ms CPU** per invocation (I/O wait does not count), **50 external subrequests** per invocation (D1/AI/KV calls have a separate 1,000 internal ceiling), 3 MB gzipped script size, 3 Cron Triggers per Worker. Cron invocations scheduled more often than hourly get **~30 s wall-clock**.
- D1 Free: 5 GB total / 500 MB per DB, 5M rows read/day, 100k rows written/day, 50 queries per invocation.
- Workers AI Free: **10,000 neurons/day**, resets 00:00 UTC. JSON mode (`response_format: json_schema`) is supported on the mainline instruct models.

Our scale (a handful of scraped messages/day, a city-pilot user base) fits comfortably; §1.14 has the budget math and the two genuinely risky limits.

---

## 1. Codebase changes (implementation specification)

### 1.1 New project layout and technology choices

Create a new top-level `worker/` directory (do **not** delete `backend/` or `ASP/` until the parity checklist in §4 passes):

```
worker/
├── wrangler.jsonc              # bindings, cron triggers, vars
├── package.json
├── tsconfig.json
├── migrations/                 # wrangler d1 migrations (plain .sql)
│   └── 0001_init.sql
├── seeds/
│   ├── generate-seed.mjs       # streets.json/regions.json → seed.sql
│   └── (streets.json, regions.json copied from backend/data/postgres/seeding/seeds/)
├── src/
│   ├── index.ts                # exports { fetch: app.fetch, scheduled }
│   ├── env.ts                  # Env interface (DB, AI, secrets, vars)
│   ├── api/
│   │   ├── app.ts              # Hono app, route registration, error handler
│   │   ├── middleware.ts       # JWT auth, ingest API key
│   │   ├── auth.ts             # /api/auth/*  (register, login, me, location, delete, export)
│   │   ├── alerts.ts           # /api/alerts/* (submit-data, recent)
│   │   ├── tokens.ts           # /api/tokens
│   │   └── preferences.ts      # /api/preferences/*
│   ├── core/
│   │   ├── alert-service.ts    # store + enrich + match + notify (port of AlertService.cs)
│   │   ├── fuzzy.ts            # pg_trgm-equivalent trigram matching
│   │   ├── geo.ts              # point-in-polygon, centroid, local projection helpers
│   │   ├── geocoding.ts        # Nominatim client + D1-backed cache
│   │   ├── onesignal.ts        # OneSignal REST client (user-addressed push)
│   │   ├── password.ts         # PBKDF2 hash/verify
│   │   ├── jwt.ts              # HS256 sign/verify helpers
│   │   └── bus-lines.ts        # port of BusLineCatalog.cs
│   ├── ingestion/
│   │   ├── runner.ts           # scheduled dispatcher, time-budget guard
│   │   ├── pipeline.ts         # port of services/common.py (AI → polygon → store → notify)
│   │   ├── ai.ts               # Workers AI wrapper with JSON-schema mode + retry
│   │   ├── polygon.ts          # port of processing/polygon.py (Overpass + JSTS)
│   │   ├── state.ts            # crawl_state repository (port of state_repository.py)
│   │   ├── scrape.ts           # port of scraping/scrape.py (cheerio parsers)
│   │   └── sources/
│   │       ├── vik.ts  ├── heating.ts   # shared id-listing crawler
│   │       ├── epro.ts ├── vt.ts
│   ├── db/
│   │   └── queries.ts          # all prepared statements in one place
│   └── shared/
│       ├── schemas.ts          # zod schemas (AI output, request bodies, DTOs)
│       └── constants.ts        # categories, severity map, windows, prompts
└── test/
    ├── fixtures/               # HTML/JSON fixtures ported from backend/tests
    └── *.spec.ts               # vitest + @cloudflare/vitest-pool-workers
```

**Dependencies (keep this list minimal — free-plan script limit is 3 MB gzipped):**

| Package | Replaces | Why |
|---|---|---|
| `hono` | ASP.NET routing/middleware/controllers | Tiny, Workers-native router; built-in JWT middleware |
| `zod` | Pydantic models + DataAnnotations | Request validation and AI-output validation; `zod-to-json-schema` generates the schema sent to Workers AI (same pattern as `model_json_schema()` → Ollama) |
| `cheerio` | BeautifulSoup | Port the four HTML parsers in [scrape.py](backend/scraping/scrape.py) with near-identical selector logic |
| `jsts` | Shapely + NetTopologySuite | Same JTS lineage as NetTopologySuite: `LineMerger`, `Polygonizer`, `union` — a faithful port of [polygon.py](backend/processing/polygon.py) |
| (none — WebCrypto) | BCrypt, firebase-admin, System.IdentityModel | See §1.4, §1.6 |

No ORM: D1's prepared-statement API (`env.DB.prepare(...).bind(...)`) with all SQL centralized in `db/queries.ts`. Drizzle is a fine optional upgrade later; it isn't needed for 7 tables.

`wrangler.jsonc` skeleton (values referenced throughout this spec):

```jsonc
{
  "name": "cityshield",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "observability": { "enabled": true },
  "triggers": { "crons": ["*/10 * * * *", "30 3 * * *"] },   // ingest tick, daily cleanup
  "d1_databases": [{ "binding": "DB", "database_name": "cityshield-db", "database_id": "<from wrangler d1 create>" }],
  "ai": { "binding": "AI" },
  "vars": {
    "AI_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "VIK_URL": "https://vikvarna.com/bg/messages.html?region_id=15&sub_region_id=&type=breakdown",
    "VT_URL": "https://www.varnatraffic.com/Info",
    "EPRO_URL": "https://www.erpsever.bg/bg/profil/xhr/?method=get_interruptions",
    "EPRO_AREA_NAME": "Варна",
    "HEATING_BASE_URL": "https://energy-varna.bg",
    "HEATING_URL": "https://energy-varna.bg/bg/съобщения-за-аварии-0",
    "OVERPASS_URL": "https://overpass.kumi.systems/api/interpreter",
    "JWT_ISSUER": "CityShield",
    "JWT_AUDIENCE": "CityShield Users",
    "JWT_EXPIRE_MINUTES": "60"
  }
}
```

Secrets (never in `vars`): `JWT_KEY`, `INGEST_API_KEY`, `ONESIGNAL_API_KEY` (the REST API key; the App ID next to it is a plain var, since it ships in the mobile app too).

### 1.2 D1 schema (`migrations/0001_init.sql`)

Port of the EF model + the Python-side tables, adjusted for SQLite:

```sql
CREATE TABLE users (
    user_id              TEXT PRIMARY KEY,             -- uuid v4
    email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,                -- pbkdf2 format, §1.4
    latitude             REAL,
    longitude            REAL,
    region_id            INTEGER REFERENCES regions(id),
    street_id            INTEGER REFERENCES streets(id),
    receives_all_alerts  INTEGER NOT NULL DEFAULT 0,   -- bool
    subscribed_bus_lines TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
    created_on_utc       TEXT NOT NULL,                -- ISO-8601 UTC ("...Z")
    updated_on_utc       TEXT NOT NULL
);
CREATE INDEX ix_users_region_street ON users(region_id, street_id);
CREATE INDEX ix_users_lat_lng ON users(latitude, longitude);

CREATE TABLE regions ( id INTEGER PRIMARY KEY AUTOINCREMENT, region_name TEXT NOT NULL UNIQUE );
CREATE TABLE streets ( id INTEGER PRIMARY KEY AUTOINCREMENT, street_name TEXT NOT NULL UNIQUE );

-- device_tokens lived here until migration 0008 dropped it: push moved to
-- OneSignal, which holds the device registrations keyed by our user_id (§1.6).

CREATE TABLE user_notification_preferences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    category   TEXT NOT NULL,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, category)
);

CREATE TABLE alerts (
    id             TEXT PRIMARY KEY,      -- uuid v4
    category       TEXT NOT NULL,         -- vik | epro | heating | vt
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    severity       TEXT NOT NULL DEFAULT 'info',
    start_time     TEXT,                  -- free-form "HH:MM" as scraped
    end_time       TEXT,
    locations_json TEXT NOT NULL DEFAULT '[]',   -- enriched locations, §1.5
    created_on_utc TEXT NOT NULL
);
CREATE INDEX ix_alerts_created ON alerts(created_on_utc);
CREATE INDEX ix_alerts_category ON alerts(category);

CREATE TABLE crawl_state (
    source     TEXT PRIMARY KEY,
    last_id    INTEGER NOT NULL DEFAULT 0,
    seen_ids   TEXT NOT NULL DEFAULT '[]',       -- JSON array, capped at 500 (port of MAX_SEEN_IDS)
    updated_at TEXT NOT NULL
);

CREATE TABLE geocode_cache (                     -- replaces the in-memory Nominatim cache, §1.5
    query       TEXT PRIMARY KEY,
    lat         REAL,                            -- NULL = cached miss
    lng         REAL,
    resolved_at TEXT NOT NULL
);
```

**Deliberate departures from the Postgres schema:**

- `users.Location geometry(Point,4326)` is **dropped**. Only `AlertService.GetUsersInPolygonRangeAsync` used it; point-in-polygon moves to TypeScript (§1.3). `latitude`/`longitude` columns are the source of truth.
- `pg_trgm` extension + GIN trigram indexes are **dropped**; fuzzy matching moves to TypeScript (§1.3).
- `jsonb` → `TEXT` with JSON; `text[]` (`SubscribedBusLines`, `seen_ids`) → JSON-array `TEXT`.
- `uuid`/`timestamptz` → `TEXT` (uuid string / ISO-8601 with `Z` — `new Date().toISOString()` output sorts correctly lexicographically, which the alert index relies on).
- `ON DELETE CASCADE` on preferences (and, until 0008, `device_tokens`): makes GDPR account deletion (§1.10) a single `DELETE FROM users`. Enable `PRAGMA foreign_keys` semantics by always deleting through `queries.ts` (D1 enforces FKs by default; verify in a test).

Seeding: `seeds/generate-seed.mjs` reads the existing `streets.json` / `regions.json` (copied from [backend/data/postgres/seeding/](backend/data/postgres/seeding/)) and emits `INSERT OR IGNORE` statements → applied with `wrangler d1 execute` (§3.3). The `buses` table is not carried over (already dropped by the seeder).

### 1.3 Replacing PostGIS: fuzzy matching and point-in-polygon in TypeScript

**Trigram similarity (`core/fuzzy.ts`)** — used by four call sites today: [FuzzyMatchExtensions.cs](ASP/CityShieldAPI/CityShieldAPI.Data/FuzzyMatchExtensions.cs) (region + street match during alert targeting and location update) and [polygon.py `resolve_street_names`](backend/processing/polygon.py#L276-L304). Implement pg_trgm's exact semantics so match behavior doesn't drift:

1. Normalize: lowercase, collapse whitespace, then pad with two leading spaces and one trailing space per word (pg_trgm behavior).
2. Extract all 3-grams of the padded string into a `Set`.
3. `similarity(a, b) = |trigrams(a) ∩ trigrams(b)| / |trigrams(a) ∪ trigrams(b)|`.
4. `bestMatch(name, candidates, threshold)` returns the highest-scoring candidate above the threshold, else `null`. Thresholds: **0.3** for region/street matching (pg_trgm's default `%` threshold, which is what the current SQL uses) and **0.4** for polygon street resolution (the `similarity_threshold` parameter in `streets_to_geojson`).

Candidate lists come from D1 (`SELECT id, street_name FROM streets`) and are cached in **module scope** with a 6-hour TTL — Workers isolates live across invocations, so most calls hit the warm cache; a cold isolate costs one ~3k-row D1 read (well inside limits). Varna has a few thousand streets; a linear scan with Set intersection is well under 1 ms.

**Point-in-polygon (`core/geo.ts`)** — replaces `polygon.Contains(u.Location)`:

1. Compute the polygon's bounding box.
2. SQL prefilter: `SELECT ... FROM users WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`.
3. Exact ray-casting test in TS on the survivors (a 30-line standard algorithm; no turf dependency needed). Treat boundary as inside (matches NTS `Contains` closely enough for this use).

Also in `geo.ts`: `polygonCentroid` (average of outer-ring vertices — port of `PolygonCentroid` in AlertService.cs, same "good enough for a map pin" contract) and the local equirectangular projection used by the polygon builder (§1.9).

### 1.4 API layer port (`api/`)

**Contract parity is the hard requirement:** the RN app ([frontend/src/services/api.ts](frontend/src/services/api.ts)) must work unchanged. Exact routes, status codes, and JSON field casing (note the split: auth/preferences DTOs are camelCase, alert DTOs are snake_case — both are locked in by the app's types):

| Route | Auth | Request → Response (unchanged) |
|---|---|---|
| `POST /api/auth/register` | — | `{email, password}` → 200 text `"User successfully registered"`; 409 text on duplicate |
| `POST /api/auth/login` | — | `{email, password}` → 200 `{token}`; 401 text `"Invalid email or password"` |
| `GET /api/auth/me` | JWT | → `{email, latitude, longitude, hasLocation, regionName, streetName, createdOnUTC, updatedOnUTC}` |
| `PUT /api/auth/location` | JWT | `{latitude, longitude}` → 204. Reverse-geocode via Nominatim, fuzzy-match region/street (§1.3), persist lat/lng + ids |
| `GET /api/alerts/recent` | JWT | → `AlertDTO[]`: `{id, original_message:{title,content}, processed_data:{locations,start_time,end_time}, source, severity, created_at}`; locations entries `{location_name, sublocations, is_polygon, polygon_geojson?, lat?, lng?}` (omit null keys). 48 h window, limit 100, newest first |
| `POST /api/alerts/submit-data` | `X-Api-Key` | Kept for manual test injection (port of [send_test_alerts.py](backend/scripts/send_test_alerts.py) usage); same body as today, calls the same internal `ingestAlert()` the scrapers now call directly. Same semantics: store first, then notify, notification failure never fails the request; unknown category → 400; non-array locations → 400 |
| `POST /api/tokens` | JWT | `{token, platform?, deviceName?}` → 204 (upsert, refresh `last_seen_at`) |
| `DELETE /api/tokens` | JWT | `{token}` → 204 |
| `GET /api/preferences` | JWT | → `[{category, label, isEnabled}]` for all 5 known categories (default enabled) |
| `PUT /api/preferences/{category}` | JWT | `{isEnabled}` → 204; unknown category → 400 |
| `GET /api/preferences/bus-lines` | JWT | → `{available, selected}` |
| `PUT /api/preferences/bus-lines` | JWT | `{busLines}` → 204; unknown line → 400 |
| `DELETE /api/auth/me` | JWT | **New (GDPR, §1.10)** → 204 |
| `GET /api/auth/me/export` | JWT | **New (GDPR, §1.10)** → JSON dump of the user's data |

Port `KnownCategories` (vik/vt/epro/heating with the same labels) and [BusLineCatalog.cs](ASP/CityShieldAPI/CityShieldAPI.Core/BusLineCatalog.cs) verbatim into `shared/constants.ts` / `core/bus-lines.ts` — including `Normalize`'s Cyrillic А→A / Б→B mapping and the `"0"` sentinel.

**JWT (`core/jwt.ts` + `api/middleware.ts`):** HS256 via WebCrypto (Hono's `hono/jwt` helpers are sufficient). Claims: `sub` = user id, `email`, `iss`/`aud` from vars, `exp` = now + 60 min. The app treats the token as opaque, so switching claim names from the .NET URI-style claims to standard `sub` is safe. Middleware returns 401 with no body on missing/invalid/expired tokens (the app only checks `response.ok`).

**Passwords (`core/password.ts`):** BCrypt cannot run within the 10 ms CPU budget; use **PBKDF2-SHA-256 via `crypto.subtle`** (native, fast). Format: `pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>`, salt 16 random bytes, iterations = **100,000** (Workers caps WebCrypto PBKDF2 iterations — use the max allowed at implementation time; the self-describing format lets us raise it later and lazily rehash on successful login). Compare with `crypto.subtle.timingSafeEqual`. There are no production users today, so no bcrypt-migration path is needed — but if any test users exist in the Neon DB, they re-register.

**Login throttling:** the old stack had none either, but PBKDF2\@100k is weaker than bcrypt, so add a cheap in-worker guard: per-`(email, ip)` counter in module memory (best-effort) rejecting >10 attempts/min with 429. Optionally upgrade to Cloudflare's rate-limiting binding once on a custom domain.

**Error handling:** Hono `onError` → uniform `{"error": "An unexpected error occurred."}` 500 without stack traces (parity with the production exception handler in [Program.cs](ASP/CityShieldAPI/CityShieldAPI/Program.cs)). Startup guards become deploy-time checks: a tiny `assertConfig(env)` called lazily on first request — refuse to serve if `JWT_KEY` is missing/short or `INGEST_API_KEY` unset.

### 1.5 Alert service port (`core/alert-service.ts`)

Direct port of [AlertService.cs](ASP/CityShieldAPI/CityShieldAPI.Core/AlertService.cs), preserving every behavioral guard:

- **`storeAlert`**: enrich locations (below), insert row, severity from the same category map (vik/epro/heating = warning, vt = info, unknown = info). Store **before** notifying — same crash-safety reasoning as today.
- **Location enrichment** (port of `EnrichLocationsAsync`): normalize `polygon_geojson` to a bare geometry (accept FeatureCollection or bare geometry — keep `ExtractPolygonGeometry`'s exact acceptance rules), centroid for polygons; otherwise fuzzy-canonicalize name → forward-geocode via Nominatim (first of up to 3 sublocations wins, then location_name; same `BuildQuery` Varna-anchoring and prefix-stripping rules).
- **Targeting** (port of `SendUsersNotificationAsync`), same decision tree:
  1. locations present → per location: polygon → bbox+ray-cast user query (§1.3); else region fuzzy match (+ optional street fuzzy match) → users by `region_id`/`street_id`.
  2. no locations + `city_wide === false` → **store-only, never broadcast** (the LLM-misparse guard — keep it).
  3. no locations + `city_wide` true/absent → all user ids.
  4. `bus_lines` present and specific → keep only users whose `subscribed_bus_lines` is empty or overlaps (after `Normalize`).
  5. add `receives_all_alerts` users; dedupe; filter by per-category preference (default enabled when no row).
- **Push body**: append `(start – end)` time suffix, truncate at 1,000 chars with `…` (payload-size guard) — port verbatim.
- **`getRecentAlerts`**: 48 h / 100 rows / newest first; tolerate corrupt `locations_json` by returning `[]` for that alert.

**Nominatim client (`core/geocoding.ts`):** the singleton in-memory cache + 1 rps `SemaphoreSlim` throttle doesn't survive stateless isolates, so:

- Cache goes to the `geocode_cache` D1 table (cache misses too, as today). Check D1 → on miss call Nominatim → write back.
- Throttle becomes *structural*: geocoding only happens during ingestion of a new alert (a few calls, executed sequentially with ≥1,100 ms spacing between uncached calls) and during `PUT /api/auth/location` (one call). That keeps us inside the Nominatim public-instance policy without shared state. Keep the descriptive `User-Agent: CityShieldAPI/1.0 (contact email)` — required by their ToS.
- If usage ever grows past hobby scale, move geocoding behind a Durable Object or self-host — noted, not built now.

### 1.6 Push notifications via OneSignal (`core/onesignal.ts`)

**Superseded the original FCM HTTP v1 client (2026-07-21).** That design sent one request per
device token, because FCM v1 has no multicast endpoint, and chained self-invocations through an
`/internal/push-batch` route to get past the free tier's 50-subrequest ceiling. Fan-out cost grew
with the *device* count and the chain was serial, so a city-wide alert to N users cost ⌈N/30⌉
chained Worker invocations against a 100k/day request budget. That was the scaling wall.

OneSignal takes a list of *users* per call and fans out on its own infrastructure:

1. `POST https://api.onesignal.com/notifications`, header `Authorization: Key <ONESIGNAL_API_KEY>`.
2. Body: `{app_id, target_channel: "push", include_aliases: {external_id: [...]}, headings: {en},
   contents: {en}, data}` — data values all strings (`category`, `startTime`, `endTime`).
3. `external_id` is our own `user_id`; the app sets it with `OneSignal.login()` on sign-in and
   clears it with `OneSignal.logout()` on sign-out. Nothing device-specific is stored server-side.
4. Chunk the audience at `MAX_ALIASES_PER_REQUEST` (2,000, the documented per-call cap) and send
   chunks concurrently. Cost is ⌈users/2000⌉ subrequests, so a single invocation's budget covers
   100,000 users — no chaining, and risk #5 in §3 is retired rather than mitigated.

**Targeting stays entirely ours** (§1.5): polygon ray-cast and trigram name matching cannot be
expressed as OneSignal segment filters, and keeping them here means the provider only ever
receives the ids of users we already decided to notify — never a location.

**No stale-token handling and no `device_tokens` table** (dropped in migration `0008`). OneSignal
owns the device registrations and their unsubscribe lifecycle; a 200 response listing unknown
aliases is normal churn, logged and ignored. The `/api/tokens` routes are gone with it, so the
daily cleanup cron (`30 3 * * *`) now runs only the §1.10 retention jobs.

**Missing credentials degrade, never fail:** without `ONESIGNAL_API_KEY`/`ONESIGNAL_APP_ID` the
sender warns and skips, exactly as the FCM client did — a notification failure must never fail a
request whose alert is already stored.

### 1.7 Ingestion port (`ingestion/`)

**Scheduling model.** The five asyncio loops with per-source intervals collapse into one cron tick every 10 minutes (all sources currently use the 600 s default anyway — per-source intervals die with this migration; if ever needed, run a source only when `tickMinute % N === 0`).

```ts
// index.ts
export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") ctx.waitUntil(runIngestion(env));
    if (event.cron === "30 3 * * *")  ctx.waitUntil(runDailyCleanup(env));
  },
};
```

**The 30-second wall-clock budget** (sub-hourly cron on the free plan) is the binding constraint, and the existing crawler design already tolerates partial progress — keep its exact semantics:

- `runner.ts` runs sources **sequentially** with a deadline guard (`const deadline = Date.now() + 25_000`); before starting each message it checks the deadline and stops cleanly if exceeded.
- Cap work per tick: **max 2 new messages per source per tick**. Anything left is picked up next tick because…
- …the cursor semantics from [common.py `crawl_id_listing`](backend/services/common.py#L278-L372) are ported verbatim: process oldest-first, advance `last_id` only past *successes*, a failed message blocks newer ones (so a retried run can't re-notify), a persistently failing message ages off the listing. For seen-id sources, ids are persisted per-message on success (port of the `finally: add_seen_ids` pattern so a mid-run abort never re-broadcasts earlier successes).
- Rotate the source start order by tick number so a slow source can't starve the others.

**Per-source modules** — each exports `run(env, deadline): Promise<void>`:

| Source | Port notes |
|---|---|
| `vik.ts` | id-listing crawler, `(\d+)\.html` pattern, listing + message parsers from scrape.py → cheerio |
| `heating.ts` | id-listing crawler, `/node/(\d+)` pattern, base-URL-relative links |
| `epro.ts` | JSON XHR endpoint (`X-Requested-With` header), same two active buckets, sha-256 content hash ids (24 hex chars), `strip_html` port |
| `vt.ts` | accordion parse, data-id or sha1 fallback ids, bus-lines prompt (`{bus_lines}`, `["0"]` sentinel, `null` = irrelevant), submit as city-wide `vt` alert with `bus_lines`; "Засегнати линии: …" content suffix |

**`pipeline.ts`** (port of `common.py`'s tail): `aiParse → zod-validate → buildPolygons → ingestAlert()`. The old HTTP POST to the ASP.NET API becomes a direct call into `alert-service.ts` (`storeAlert` + `dispatchNotifications` under the same never-fail-after-store rule). The two prompts (`OUTAGE_AI_PROMPT`, VT) are copied **character-for-character** into `constants.ts` — they're tuned for Bulgarian abbreviation handling; don't "improve" them during the port.

**Scrape client (`scrape.ts`):** port `fetch_page` (browser-like `DEFAULT_HEADERS`, timeouts via `AbortSignal.timeout(20_000)`, raise-for-status) and the five parse functions onto cheerio, asserting against the fixture HTML files ported from [backend/tests/](backend/tests/).

### 1.8 Workers AI integration (`ingestion/ai.ts`)

Port of [ai_parser.py](backend/processing/ai_parser.py) minus the debug disk cache:

```ts
async function aiParse<T>(env: Env, system: string, user: string, schema: ZodType<T>): Promise<T | null> {
  const jsonSchema = zodToJsonSchema(schema);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await env.AI.run(env.AI_MODEL, {
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: jsonSchema },   // JSON mode
      });
      return schema.parse(typeof res.response === "string" ? JSON.parse(res.response) : res.response);
    } catch (e) { if (attempt === 3) { log(e); return null; } await sleep(1000 * attempt); }
  }
  return null;
}
```

- Zod schemas mirror the Pydantic ones exactly, including the fields hidden from the model (`polygon_geojson`, `bus_lines` are *not* in the generated JSON schema — build a separate "AI-facing" zod object, then widen after parse; same trick as `SkipJsonSchema`).
- `null` on any failure so a source skips the message and retries next tick — identical contract to today.
- **Model choice:** default `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (strong multilingual extraction, supports JSON mode). It's a `vars` entry, so swapping to `@cf/meta/llama-3.1-8b-instruct` (≈10× cheaper in neurons) or a Qwen model is a config change. **Validation task before cutover (§4):** replay the fixture messages from `backend/tests` through 2–3 candidate models and compare against the qwen3.5 outputs the current tests encode.
- Budget: tens of messages/day × ~1–2k tokens each — comfortably inside 10,000 neurons/day even on the 70B model. If the daily cap is ever hit, `AI.run` fails → messages wait (cursor holds) → processed after 00:00 UTC reset. Acceptable degradation; no code needed.
- Route calls through a (free) **AI Gateway** for request logs/replay: change binding call to `env.AI.run(model, inputs, { gateway: { id: "cityshield" } })` — replaces the old `AI_PERSISTENT_CACHE` debugging aid.

### 1.9 Polygon builder port (`ingestion/polygon.ts`)

Port of [polygon.py](backend/processing/polygon.py), replacing OSMnx/GeoPandas with a direct Overpass query + JSTS. Pipeline for a location with `is_polygon: true`:

1. **Resolve street names** against the `streets` table with `fuzzy.ts` (threshold 0.4). Fewer than 3 resolved → log + `polygon_geojson = null` (same bail-out).
2. **Fetch geometries** (replaces `ox.features_from_place`): one Overpass QL request —
   ```
   [out:json][timeout:20];
   area["name"="Варна"]["boundary"="administrative"]->.a;
   way(area.a)["highway"]["name"~"^(<escaped names joined by |>)$"];
   out geom;
   ```
   Group returned ways by `tags.name` → arrays of coordinate lines. Cache responses in module memory keyed by sorted street list (the Python side had `ox.settings.use_cache`).
3. **Project** to local metric space: `x = (lon − lon₀) · 111320 · cos(lat₀)`, `y = (lat − lat₀) · 111320` (city-scale equirectangular; replaces `project_gdf`).
4. **JSTS pipeline**, mirroring the Python steps: per street `LineMerger`; extend each line's ends by 200 m along the end-segment direction (straight port of `extend_line`/`extend_geometry`); `UnaryUnionOp` over all extended lines; `Polygonizer`.
5. **Candidate filter** — same rule, cheaper implementation than buffer-intersection (10 ms CPU budget): for each candidate polygon, for each street, sample points every ~5 m along the exterior ring and count a street as "touching" if a run of >5 m of samples lies within 1 m of the street geometry (`distance` predicates instead of `buffer(1).intersection().length`). Keep: ≥2 distinct touching streets required, sort by (touchCount, area) desc, take the winner.
6. **Output**: reproject winner to WGS84, emit the same **FeatureCollection** shape `streets_to_geojson` produced (properties `streets: [...]`) — enrichment already accepts it.
7. Any exception → log + `null`, never fail the message (port of `build_polygons`' catch-all).

CPU note: steps 4–5 are the only meaningfully CPU-heavy code in the whole Worker. For 3–6 streets they should land in low single-digit milliseconds; if profiling shows spikes past the free-plan CPU limit, first lever is coarser sampling in step 5, second is Workers Paid ($5/mo → 30 s CPU). Do not preemptively pay.

The standalone [overpass.py](backend/data/overpass/overpass.py) region-name exporter is a dev tool for regenerating `regions.json` — port it as `seeds/fetch-region-names.mjs` (plain Node script, not part of the Worker).

### 1.10 New GDPR-driven functionality (see §2 for the legal basis)

- **`DELETE /api/auth/me`** (JWT): delete the user row (cascades to tokens + preferences), return 204. Log only a non-identifying event. *Frontend: add a "Delete account" button in settings with a confirm dialog — Google Play also requires in-app account deletion for apps with accounts.*
- **`GET /api/auth/me/export`** (JWT): return all stored personal data as JSON (profile, preferences, bus lines, device-token metadata) — Art. 20 portability with trivial effort.
- **Retention jobs** in the daily cron: device tokens >60 days unseen (already specced); **alerts older than 90 days deleted** (they're public-source data, but unbounded growth also fights the 500 MB DB cap); `geocode_cache` rows older than 180 days.
- **Privacy policy page**: static page served by the Worker itself at `/privacy` (one Hono route returning HTML; no separate hosting needed). Linked from the app and the Play Store listing. Contents checklist in §2.5.

### 1.11 Frontend changes (deliberately minimal)

- Release builds: `CITYSHIELD_API_URL=https://<worker-url>` (already enforced at bundle time by [config.ts](frontend/src/config.ts); workers.dev URLs are HTTPS, satisfying the cleartext restriction).
- Add the account-deletion screen/action (§1.10) and a link to `/privacy`.
- Everything else — auth flow, map, feed, preferences — untouched; §1.4's contract table is the guarantee. (Push handling was later swapped to OneSignal, §1.6.)

### 1.12 Tests and CI

- **Unit/integration**: `vitest` + `@cloudflare/vitest-pool-workers` (runs tests inside workerd with a real local D1; Workers AI calls in tests are mocked — a fake `AI` binding returning canned JSON from the fixture set). Port, in priority order: scrape parsers (fixtures), fuzzy matcher (add cases mirroring pg_trgm results for Cyrillic names), crawler cursor semantics (the retry/blocking behaviors encoded in [test_common.py](backend/tests/test_common.py)), alert targeting decision tree (the city_wide/bus-lines guards from the xUnit suite), polygon builder (fixture Overpass JSON), API contract tests (register/login/me/recent round-trips against local D1).
- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)): replace the `ingestion` (pytest) and `api` (dotnet) jobs with one `worker` job — `npm ci && npm test && npx wrangler deploy --dry-run` (build+size check). Keep the `app` job. Add a `deploy` job on `main` using `cloudflare/wrangler-action` with a `CLOUDFLARE_API_TOKEN` repo secret (§3.5).

### 1.13 Decommissioning (after §4 parity checklist passes)

Delete `backend/`, `ASP/`, `docker-compose.prod.yml`, `.env.example` (replaced by `worker/.dev.vars.example`), and the Python/.NET sections of `InstallDependencies.bat`; rewrite README architecture/getting-started sections. Neon/Cloud SQL plans are dead; the Neon project (if already created) gets deleted after cutover.

### 1.14 Free-tier budget and the honest risk list

Daily budget at pilot scale (500 users, ~20 scraped messages/day):

| Resource | Free limit/day | Projected | Headroom |
|---|---|---|---|
| Worker requests | 100,000 | ~5k app traffic + 145 cron | ~20× |
| D1 rows read | 5,000,000 | ~200k (feed reads + street-cache reloads) | ~25× |
| D1 rows written | 100,000 | < 1k | ~100× |
| Workers AI neurons | 10,000 | ~1–3k (70B model, ~30 calls) | ~3–10× |
| Storage | 500 MB/DB | < 50 MB after years (with 90-day alert retention) | ~10× |

**Real risks, ranked:**

1. **Source sites blocking Cloudflare egress IPs.** Scrapes now originate from Cloudflare's ranges; erpsever.bg or varnatraffic.com may treat them differently than a residential/VM IP. **Mitigation: §4 phase 0 spike — deploy a throwaway Worker that fetches all 5 sources and compare against fixtures *before* writing anything else.** Fallback if one source blocks: a tiny fetch-proxy elsewhere (e.g., a free-tier VPS or GitHub Action pushing raw HTML to the ingest endpoint) for that source only.
2. **30 s cron wall-clock.** Handled structurally (§1.7: 2 msgs/source/tick, deadline guard, cursor retry). Worst case is delayed, never lost, alerts.
3. **10 ms CPU on polygon building.** Mitigated in the design (§1.9); measurable via `wrangler tail` CPU metrics; $5/mo escape hatch.
4. **LLM quality drop vs qwen3.5 on Bulgarian.** Gated by the §4 model eval before cutover; model is a config var.
5. **50-subrequest fan-out ceiling.** ~~Chained self-invocation~~ — retired: OneSignal fans out per *user*, 2,000 per request, so one invocation covers 100,000 users (§1.6).

---

## 2. Security, legal & GDPR

CityShield stores real personal data — **email, password hash, precise home location, device push tokens** — so GDPR applies in full. You (the operator) are the **data controller**; the supervisory authority is Bulgaria's **КЗЛД / CPDP** (cpdp.bg).

### 2.1 Personal-data inventory (Art. 30 record — keep this table updated in the repo)

| Data | Where | Purpose | Lawful basis | Retention |
|---|---|---|---|---|
| Email + password hash | D1 `users` | Account/auth | Contract (Art. 6(1)(b)) | Until account deletion |
| Precise lat/lng + region/street | D1 `users` | Location-matched alerts | **Consent** (Art. 6(1)(a)) — location is optional and user-initiated | Until changed/deleted |
| Push registration (device ↔ `user_id`) | **OneSignal**, not our D1 | Push delivery | Contract | Until logout (`OneSignal.logout()`) or account deletion |
| Category prefs, bus-line subs | D1 | Feature | Contract | Until account deletion |
| Request logs (IP, UA) | Workers Logs | Security/debugging | Legitimate interest (Art. 6(1)(f)) | Cloudflare default (~3–7 days); don't log request bodies containing passwords/locations |
| Alert content | D1 `alerts` | Core service | n/a — public utility announcements, not personal data | 90 days (§1.10) |

Data-minimization notes: we store no names, no phone numbers, no analytics/tracking SDKs; keep it that way. Location is the sensitive item — it's collected only via the explicit "set my location" flow, which is the right design; make the app's consent copy say what it's used for.

### 2.2 Processors and international transfers

| Processor | What they see | Paperwork to do (all free, all self-service) |
|---|---|---|
| **Cloudflare** (Workers/D1/AI) | Everything in transit + at rest | Accept the Cloudflare **Data Processing Addendum** (auto-incorporated into the self-serve terms; download a copy). Cloudflare is EU-US **Data Privacy Framework**-certified and offers SCCs. Create the D1 database with `--location=weur` so data-at-rest sits in Western Europe (§3.3). Workers execute at edge locations globally — that's data-in-transit processing covered by the DPA/SCCs; Workers AI inputs are alert texts (not personal data). |
| **OneSignal** (US) | `user_id` as external id, device push registration, notification content | Accept OneSignal's **DPA** and record its transfer mechanism (DPF or SCCs); list it as a processor in the privacy policy. Never receives location, email or preferences. |
| **Google / Firebase (FCM)** | The Android delivery channel beneath OneSignal | Accept Google's **Data Processing Terms** in the Firebase console; list Google as a processor. Push content is outage info, not personal data. |
| **OSM Foundation (Nominatim)** | ⚠️ The user's **precise coordinates** on `PUT /api/auth/location`, and street names during ingest | OSMF's public instance has **no DPA** — this is the one genuinely awkward transfer. Handle it with: (a) explicit disclosure + consent in the location-setting flow ("your coordinates are sent to OpenStreetMap's Nominatim service to determine your district"); (b) the request carries no user identifier and originates from Cloudflare's IP, not the user's — genuinely low-risk pseudonymized processing; (c) link OSMF's privacy policy. If you ever want this fully clean: self-host Nominatim (overkill now) or switch to a commercial EU geocoder with a DPA. Documented decision: keep Nominatim + disclose. |
| Overpass (kumi.systems) | Street names only | No personal data; nothing needed beyond fair-use compliance. |

### 2.3 Data-subject rights — how each is satisfied

- **Access/portability (Art. 15/20):** `GET /api/auth/me` + new `/api/auth/me/export` (§1.10).
- **Rectification (Art. 16):** location can be re-set in-app; email changes can be handled manually via support address until an endpoint exists.
- **Erasure (Art. 17):** new `DELETE /api/auth/me` with cascade (§1.10) + in-app button (also a Google Play requirement).
- **Withdraw consent (location):** add "clear my location" (set lat/lng/region/street to NULL) — small endpoint, include in §1.10 implementation (`PUT /api/auth/location` with a `clear` flag or a `DELETE /api/auth/location`).
- **Objection/restriction:** per-category notification toggles already exist; support email for the rest.

### 2.4 Security measures (Art. 32)

- TLS everywhere by default (workers.dev / Cloudflare-proxied domain); Android release builds already refuse cleartext.
- PBKDF2 at max permitted iterations, per-user salt, timing-safe compare, login throttling (§1.4).
- Secrets only in `wrangler secret` (never in git — `.dev.vars` is gitignored); JWT key ≥ 48 random bytes; rotate by re-`put` + redeploy.
- Ingest/test endpoint gated by `INGEST_API_KEY`.
- Least privilege: the Firebase service account uploaded to OneSignal carries **only** the "Firebase Cloud Messaging API" role (not the default admin SA). The `ONESIGNAL_API_KEY` secret can send pushes but cannot read subscriber data.
- Backups/integrity: D1 Time Travel gives point-in-time restore (7 days on free) — document `wrangler d1 time-travel` in the README ops section.
- **Breach plan (Art. 33/34):** 72-hour notification to CPDP; the practical prep is: know what's logged (Workers Logs), keep the processor list (§2.2) current, and write a one-paragraph internal runbook: detect → assess scope via logs → notify CPDP via cpdp.bg form → notify affected users via push/email if high-risk.

### 2.5 Privacy policy & terms (ship with the app, §1.10 hosts it at `/privacy`)

Bulgarian + English. Must cover: controller identity + contact email; the inventory table of §2.1 in prose; purposes and lawful bases; processors (Cloudflare, OneSignal, Google FCM, OSMF Nominatim) and transfer safeguards (DPF/SCCs); retention periods; all Art. 15–21 rights + how to exercise them (in-app + email); right to lodge a complaint with CPDP; no automated decision-making with legal effects; no sale of data; cookies — none (API only). Also complete the **Google Play Data Safety form** consistently with this policy (collects: email, precise location, device IDs — all "app functionality", none shared for ads).

You don't need: a DPO (Art. 37 thresholds not met), a DPIA (no large-scale systematic monitoring — but keep this answer written down with one paragraph of reasoning), or a data-protection officer registration with CPDP (Bulgaria abolished general registration post-GDPR).

### 2.6 Non-GDPR legal items

- **OSM attribution (ODbL):** the app's Leaflet map must show "© OpenStreetMap contributors" (verify it survives in the WebView), and the About screen should credit Nominatim/Overpass. Also mind the **OSM tile usage policy** — if the app gets popular, switch tiles to a provider with a free tier (e.g., Carto) rather than hammering osm.org tiles.
- **Nominatim usage policy:** ≤1 req/s, descriptive User-Agent, caching — all satisfied by §1.5's design; keep it that way.
- **Scraped sources:** factual public-safety announcements from official operator/agency pages — facts aren't copyrightable, volumes are trivial (a page every 10 min), and EU's DSM Art. 4 text-and-data-mining exception covers the automated extraction; we don't republish full articles (outage notices are short operational texts). Keep per-source polling ≥10 min, honor robots.txt if any of the four sources adds one, and show the source name in the app (the category labels already do). Risk is low; if a source ever objects, that category gets switched off — no legal exposure worth pre-lawyering.
- **Firebase terms:** already accepted when the project was created; nothing new. **OneSignal's DPA is new** and must be accepted before release (§2.2).

---

## 3. Registration & cloud setup (step-by-step)

### 3.1 Accounts

1. **Cloudflare**: dash.cloudflare.com → sign up (free, no credit card for the free plan). Use a team-accessible email, not a personal one. Enable 2FA.
2. **OneSignal**: create the app, and under Android settings upload a minimal-role Firebase service-account JSON (Google Cloud console → IAM → Service Accounts → create → grant "Firebase Cloud Messaging API Admin" → create JSON key) and set the Android package name. Copy the App ID and REST API Key.
3. No other accounts needed. (No domain required — `cityshield.<account>.workers.dev` is fine for launch. A custom domain later: register/transfer via Cloudflare Registrar ≈ $10/yr, then it's one click to attach to the Worker.)

### 3.2 Local tooling

```bash
cd worker
npm init -y && npm i hono zod zod-to-json-schema cheerio jsts
npm i -D wrangler typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types
npx wrangler login          # opens browser OAuth
```

### 3.3 Provision resources

```bash
# D1 in Western Europe (GDPR §2.2) — copy database_id into wrangler.jsonc
npx wrangler d1 create cityshield-db --location=weur

# schema + reference data
npx wrangler d1 migrations apply cityshield-db --remote
node seeds/generate-seed.mjs && npx wrangler d1 execute cityshield-db --remote --file=seeds/seed.sql

# secrets
openssl rand -base64 48 | npx wrangler secret put JWT_KEY
openssl rand -hex 32    | npx wrangler secret put INGEST_API_KEY
npx wrangler secret put ONESIGNAL_API_KEY     # OneSignal REST API key
```

Workers AI needs no provisioning — the `ai` binding in `wrangler.jsonc` is enough. Optionally create an AI Gateway named `cityshield` in the dashboard (AI → AI Gateway) for request logging (§1.8).

### 3.4 Deploy & verify

```bash
npx wrangler deploy                      # prints https://cityshield.<account>.workers.dev
npx wrangler tail                        # live logs
npx wrangler d1 execute cityshield-db --remote --command "select count(*) from streets"
curl -X POST .../api/alerts/submit-data -H "X-Api-Key: ..." -d @test-alert.json   # smoke test
```

Cron triggers activate on deploy; the dashboard (Workers → cityshield → Triggers) shows past cron invocations. Local dev: `npx wrangler dev` (local D1 + simulated crons via `--test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"`). **Note:** Workers AI calls from local dev proxy to the real service and consume neurons.

### 3.5 CI deploys

Dashboard → My Profile → API Tokens → create token from the "Edit Cloudflare Workers" template, scoped to the account → GitHub repo secret `CLOUDFLARE_API_TOKEN` → the §1.12 deploy job (`cloudflare/wrangler-action@v3`, `command: deploy`, `workingDirectory: worker`) on pushes to `main`. (Alternative: Cloudflare's git-connected Workers Builds — fine too, pick one, not both.)

### 3.6 Limit references to re-check at implementation time

- Workers limits: developers.cloudflare.com/workers/platform/limits/
- D1 limits & pricing: developers.cloudflare.com/d1/platform/limits/
- Workers AI pricing/models/JSON mode: developers.cloudflare.com/workers-ai/
- Cron triggers: developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare DPA: cloudflare.com/cloudflare-customer-dpa/

---

## 4. Rollout phases & parity checklist

**Phase 0 — de-risking spikes (do these before writing the real code):**
1. Throwaway Worker fetching all 5 source URLs from the deployed edge → diff against known-good HTML/JSON (risk #1 in §1.14).
2. Workers AI model eval: run the fixture messages through llama-3.3-70b-fast, llama-3.1-8b, and the newest Qwen model with the untouched prompts + JSON mode; compare to the expected outputs in `backend/tests`. Pick the cheapest model with zero regressions.
3. JSTS polygon spike: rebuild the four street sets in [polygon.py's `__main__`](backend/processing/polygon.py#L309-L331) and compare polygons (rough shape + centroid) with the Python output.

**Phase 1 — data & API core:** migrations, seeds, fuzzy.ts, auth (register/login/me/location), tokens, preferences, contract tests. *Milestone: RN debug app pointed at `wrangler dev` passes a full manual auth+prefs flow.*

**Phase 2 — alerts read/write path:** alert-service.ts, geocoding + cache, push client, `submit-data` + `recent`. *Milestone: injecting a test alert via curl produces a push on a real device and renders on the map.*

**Phase 3 — ingestion:** scrape.ts + fixtures, ai.ts, polygon.ts, sources, runner. *Milestone: deployed Worker left running for 48 h processes real source messages end-to-end (verify against the sources manually).*

**Phase 4 — GDPR & polish:** delete/export/clear-location endpoints, `/privacy` page + policy text, retention jobs, frontend deletion screen + URL switch, CI rewrite.

**Phase 5 — cutover:** release build with the workers.dev URL → Play Store update → 1 week of `wrangler tail`/dashboard monitoring → execute §1.13 decommissioning → update README.

**Parity checklist (gate for deleting old code):** every §1.4 endpoint verified from the app; all 5 sources have ingested ≥1 real message; a polygon alert notified only in-polygon test users; a city_wide=false empty-locations alert stored without broadcasting; a vt alert respected bus-line filters; stale-token cleanup ran; account deletion verified to cascade.
