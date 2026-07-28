# CityShield — System Specification

Real-time utility-outage alerts for Varna, Bulgaria. The server side is **one
TypeScript Cloudflare Worker** on Cloudflare's free plan; the client is a React
Native Android app.

```
official sources ──► scheduled() every 15 min ──► D1 ──► fetch() (Hono) ──► React Native app
(ViK, ERP Sever,     scrape → AI parse →              /api/auth  /api/alerts
 Veolia, VarnaTraffic) geocode → polygon →            /api/preferences  /privacy
                      store → target → push (OneSignal)
```

This document specifies the system **as built**. It is the reference for how each
part behaves and, more importantly, *why* — most of the non-obvious rules here
exist because the obvious version broke something. [TODO.md](TODO.md) tracks what
is left before a Play Store release; [SETUP.md](SETUP.md) is the operator's
account/credential checklist; [COMPLIANCE.md](COMPLIANCE.md) holds the GDPR
paperwork record.

- §1 — implementation specification (layout, data, API, alerts, ingestion, app)
- §2 — security, legal & GDPR
- §3 — operations (provisioning, deploy, tools, monitoring, platform limits)
- §4 — history: what this replaced, and the parity checklist it had to pass

**Deployment:** `https://cityshield.cityshield-varna.workers.dev`, D1 in `weur`,
crons `*/15 * * * *` (ingest) and `30 3 * * *` (cleanup).

**Free-tier numbers the design is built around** (verified July 2026; links in §3.6):

- **Workers Free:** 100,000 requests/day · **10 ms CPU** per invocation (I/O wait
  does not count) · **50 external subrequests** per invocation (D1/AI/KV have a
  separate 1,000 internal ceiling) · 3 MB gzipped script · 5 Cron Triggers per
  account.
  A scheduled invocation gets *minutes* of wall clock — only CPU is capped.
- **D1 Free:** 5 GB total / 500 MB per DB · 5M rows read/day · 100k rows
  written/day · 50 queries per invocation · 100 bound parameters per statement.
  Billing counts rows **examined**, not returned, which is why §1.2's partial
  indexes exist.
- **Workers AI Free:** 10,000 neurons/day, resetting 00:00 UTC. JSON-schema mode
  is supported on some, not all, models (§1.8).

---

## 1. Implementation specification

### 1.1 Layout, runtime and dependencies

```
CityShield/
├── backend/                    the Worker — the entire server side
│   ├── wrangler.jsonc          bindings, crons, vars
│   ├── migrations/             D1 SQL migrations (0001–0014)
│   ├── seeds/                  regions/streets/aliases.json + generate-seed.mjs
│   ├── src/
│   │   ├── index.ts            exports { fetch, scheduled }
│   │   ├── env.ts              Env interface + assertConfig
│   │   ├── api/                Hono routes, middleware, rate limiting, /privacy
│   │   ├── core/               alert service, fuzzy, place-names, geo, geocoding,
│   │   │                       onesignal, jwt, password, auth-tokens,
│   │   │                       refresh-tokens, mailer, bus-lines
│   │   ├── db/queries.ts       every prepared statement, in one place
│   │   ├── ingestion/          runner, schedule, pipeline, normalize, ai,
│   │   │                       polygon, scrape, state, sources/
│   │   └── shared/             schemas, constants (prompts), datetime, deadline
│   ├── test/                   vitest suite (22 files, 359 tests) + fixtures
│   └── spikes/                 Phase 0 de-risking spikes + RESULTS.md
├── frontend/                   React Native Android app
├── tools/osm-seed-builder/     local UI that builds reference data from Overpass
├── tools/push-tester/          local UI that fires a test push
├── tools/alert-review/         local UI for judging what the pipeline stored
└── setup.bat                   Windows dependency installer
```

**Entry point** (`src/index.ts`) exports `fetch` (the Hono app) and `scheduled`.
The scheduled handler dispatches on `event.cron`, **awaits** the job rather than
handing it to `ctx.waitUntil` — the runtime waits either way, but awaiting makes
the invocation's reported duration and CPU time describe the actual work, which
is what `wrangler tail` is read against (§3.8) — and logs loudly on an
unrecognized cron expression, because a schedule edited outside `wrangler.jsonc`
otherwise looks exactly like a cron that never fired.

**Bindings** (`wrangler.jsonc`): `DB` (D1 `cityshield-db`), `AI`, and eight rate
limiters (§1.4). `compatibility_date` is `2026-07-01`; `observability` is on.

**Dependencies**, deliberately few — the free plan allows a 3 MB gzipped script
and CI enforces it with `wrangler deploy --dry-run`:

| Package | Role |
|---|---|
| `hono` | Router + middleware + JWT helpers |
| `zod` | Request validation and AI-output validation |
| `cheerio` | HTML parsing for the scrapers |
| `jsts` | JTS geometry for the polygon builder |
| (WebCrypto) | Passwords, JWT signing, token hashing — no crypto dependency |

Dev: `wrangler` (pinned to the version `@cloudflare/vitest-pool-workers`
supports), `vitest`, `@cloudflare/workers-types`, `typescript`. **No ORM**: D1's
prepared-statement API with all SQL centralized in `db/queries.ts`.

**Module-scope state.** Workers isolates survive across invocations, so a few
caches live in module scope. All of them are per-isolate and best-effort by
design — nothing is correct only because a cache is warm:

| Cache | TTL / bound | Purpose |
|---|---|---|
| `regions` / `streets` rows | 6 h, single-flight | Fuzzy matching runs on nearly every alert path (§1.3) |
| Overpass responses | 50 entries, keyed by sorted street list | Polygon rebuilds of the same block (§1.9) |
| Nominatim slot chain | — | Serializes outbound geocodes ≥1,100 ms apart (§1.5) |

### 1.2 Data model (D1)

SQLite, migrations `0001`–`0014`. Current shape:

```sql
regions ( id INTEGER PK, region_name TEXT UNIQUE, lat REAL, lng REAL )
streets ( id INTEGER PK, street_name TEXT UNIQUE, lat REAL, lng REAL )
region_aliases ( alias TEXT PK, region_id → regions ON DELETE CASCADE )  -- §1.3

users (
  user_id TEXT PK,                 -- uuid v4; also the OneSignal external_id
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,              -- pbkdf2$sha256$…, §1.4
  latitude REAL, longitude REAL,
  region_id INTEGER REFERENCES regions(id),
  street_id INTEGER REFERENCES streets(id),
  receives_all_alerts INTEGER DEFAULT 0,
  subscribed_bus_lines TEXT DEFAULT '[]',   -- JSON array
  email_verified_at TEXT,          -- NULL = unverified (soft enforcement, §1.13)
  created_on_utc TEXT, updated_on_utc TEXT
)

user_notification_preferences ( id, user_id → users ON DELETE CASCADE,
                                category, is_enabled, updated_at,
                                UNIQUE(user_id, category) )

alerts (
  id TEXT PK, category TEXT, title TEXT, content TEXT,
  severity TEXT DEFAULT 'info',
  start_time TEXT, end_time TEXT,          -- ISO local datetimes (envelope), §1.7
  windows_json TEXT,                       -- daily recurrence / extra windows, §1.7
  locations_json TEXT DEFAULT '[]',        -- enriched locations, §1.5
  created_on_utc TEXT,
  source_ref TEXT,                         -- "<category>:id=<n>" — idempotency key
  notified_at TEXT,                        -- NULL = push still owed
  push_attempts INTEGER DEFAULT 0
)

crawl_state   ( source TEXT PK, last_id INTEGER, seen_ids TEXT, updated_at TEXT )
geocode_cache ( query TEXT PK, lat REAL, lng REAL, resolved_at TEXT )  -- NULL,NULL = cached miss
auth_tokens   ( token_hash TEXT PK, user_id, purpose, expires_at, used_at, created_at )
refresh_tokens( token_hash TEXT PK, user_id, family_id, expires_at, used_at, created_at )
```

**Indexes, and why each one exists.** D1 bills rows *examined*, so an unindexed
filter on the alert fan-out path costs a full table scan **per alert**:

| Index | Query it serves |
|---|---|
| `ix_users_region_street`, `ix_users_lat_lng` | Region/street targeting, bbox prefilter |
| `ix_users_receives_all` (partial, `receives_all_alerts = 1`) | The debug-account sweep on every fan-out |
| `ix_prefs_category_optout` (partial, `is_enabled = 0`, leads with `category`) | `getDisabledUserIds` — covering search instead of a full scan |
| `ix_users_bus_lines` (partial, non-empty subscription list) | `getBusLineSubscriptions`, which reads every subscriber deliberately (filtering in memory keeps it off D1's 100-parameter ceiling for a city-wide audience) |
| `ux_alerts_source_ref` (partial, `source_ref IS NOT NULL`) | Store idempotency; manual injections carry NULL and never collide |
| `ix_alerts_created`, `ix_alerts_category` | The 48-hour feed window |
| `ix_auth_tokens_*`, `ix_refresh_tokens_*` | Issue/redeem/revoke plus the daily expiry sweep |

**Conventions.** UUID strings for ids; ISO-8601 UTC (`…Z`) text for timestamps,
which sorts lexicographically — the alert index depends on that. JSON arrays are
stored as TEXT. `ON DELETE CASCADE` from `users` makes GDPR erasure a single
`DELETE FROM users` (§1.10); D1 enforces foreign keys, and a test pins it.

**Preferences store opt-outs only** (migration 0004): an `is_enabled = 1` row is
the default written out longhand — it changes no read result and only adds rows
for the fan-out filter to examine.

**Migration history:**

| # | Change |
|---|---|
| 0001 | Initial schema (port of the EF model + the Python-side tables) |
| 0002 | Partial index for `receives_all_alerts` |
| 0003 | Delete rows left by the retired api.bg "roads" source |
| 0004 | Prune enabled-preference rows; store opt-outs only |
| 0005 | `lat`/`lng` on `regions`/`streets` (populated by the OSM seed builder) |
| 0006 | `users.email_verified_at` + `auth_tokens` |
| 0007 | `refresh_tokens` |
| 0008 | Drop `device_tokens` — push moved to OneSignal (§1.6) |
| 0009 | `alerts.source_ref` + `notified_at` + unique index (lost-push fix) |
| 0010 | `alerts.push_attempts` |
| 0011 | Targeting indexes (`ix_prefs_category_optout`, `ix_users_bus_lines`) |
| 0012 | `alerts.windows_json` — the schedule detail a flat start/end pair loses |
| 0013 | `region_aliases` — one region, several written forms |
| 0014 | Rename the five regions that collided with a like-named Varna district |

**Seeding.** `seeds/generate-seed.mjs` turns `regions.json` / `streets.json`
(252 regions, 1,333 streets, all with coordinates) plus `aliases.json` into upserts:
`INSERT … ON CONFLICT DO UPDATE SET lat = COALESCE(excluded.lat, …)`. Re-applying
adds new rows and backfills missing coordinates, and never blanks coordinates
already stored — pinned by `test/seed-upsert.spec.ts`. The data is produced by
`tools/osm-seed-builder` (§3.7); names, not OSM ids, are the key, because names
are what an alert text gives us.

### 1.3 Geospatial primitives (PostGIS replacement)

**Trigram similarity (`core/fuzzy.ts`)** — a port of `pg_trgm`'s exact semantics,
so match behaviour does not drift from the SQL it replaced:

1. Normalize: lowercase, collapse whitespace, pad with two leading and one
   trailing space per word.
2. Extract all 3-grams into a `Set`.
3. `similarity(a,b) = |A ∩ B| / |A ∪ B|`.
4. `bestMatch(name, rows, nameOf, threshold)` → highest scorer above the
   threshold, else `null`. Threshold **0.3** (pg_trgm's default `%`), or **0.4**
   for polygon street resolution. Used directly by the polygon resolver and the
   reverse-geocode assignment in `api/auth.ts`.

**Kind-aware place matching (`core/place-names.ts`)** — what resolves an alert's
*place* name, layered on top of the trigrams. Comparing whole names made the
written kind prefix noise the trigrams had to average away: bare `Аспарухово`
scored **1.000** on the village 55 km out and 0.786 on `кв. Аспарухово`, the
district in the city — so those alerts pinned a village and, because a user's
`region_id` comes from the same table, reached nobody.

1. `parseName(raw)` → `{kind, core}`, recognising every spelling the sources
   actually write (`ЖК`, `ж.к`, `м.`, `м-ст`, `ж.к "Младост"`, `ул.7`), not just
   the canonical one the prompt asks for.
2. Match on `core`, with the kind as a **filter**: a `к.к.` is never a `кв.`
   (`кв.` and `ж.к.` deliberately share a class — the sources use them
   interchangeably), and a kindless seeded row stays compatible with anything.
3. **Threshold 0.40**, not 0.30 — stripping the prefix raises every score, and
   over the 102 distinct location names the pipeline has produced every wanted
   match lands ≥ 0.417 and every false positive ≤ 0.357.
4. Ties inside a **0.2 band** go to the row inside Varna (within 9 km of the
   seeded `Варна` centroid): every source is Varna-scoped, and a like-named
   district carries orders of magnitude more users than a village. A remaining
   exact tie goes to whichever name is written most like the query, then to seed
   order — so `Младост` resolves deterministically.
5. `region_aliases` (migration 0013) is unioned into `getRegions` as ordinary
   rows carrying the target's id and coordinates, so an alternative spelling
   (`Владислав Варненчик` → `кв. Владиславово`, which scores 0.375 and is
   otherwise unreachable) resolves to the **same** `region_id` — a second region
   row would split the district's users instead of joining them.

Parsed kinds, core trigrams and the in-city flag are memoized against the
candidate array the same way `fuzzy.ts` memoizes trigrams, so the 6-hour ref
cache pays for them once rather than per alert (§1.1's 10 ms CPU budget).

**Point-in-polygon (`core/geo.ts`)** — `ringBBox` → SQL bbox prefilter
(`latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`) → exact ray-cast test
(`pointInRing`) on the survivors, boundary treated as inside. `ringCentroid` is
the vertex average — a map pin, not a centre of mass.

### 1.4 HTTP API

Contract parity with the mobile app is a hard requirement: routes, status codes
and field casing are locked in by `frontend/src/services/api.ts`. Note the split
— **auth/preferences DTOs are camelCase, alert DTOs are snake_case**.

| Route | Auth | Behaviour |
|---|---|---|
| `POST /api/auth/register` | — | `{email, password}` → 200 text `"User successfully registered"`; 409 text on duplicate (also on the UNIQUE race); mails a verification link in the background |
| `POST /api/auth/login` | — | → `{token, refreshToken}`; 401 text `"Invalid email or password"` |
| `POST /api/auth/refresh` | refresh token | `{refreshToken}` → `{token, refreshToken}`; 401 (empty body) on unknown/expired/spent |
| `POST /api/auth/logout` | — | `{refreshToken}` → 204 always |
| `GET /api/auth/me` | JWT | `{userId, email, latitude, longitude, hasLocation, regionName, streetName, emailVerified, createdOnUTC, updatedOnUTC}` |
| `PUT /api/auth/location` | JWT | `{latitude, longitude}` → 204. Reverse-geocode, fuzzy-match region/street, persist |
| `DELETE /api/auth/location` | JWT | → 204. Withdraw location consent (clears lat/lng + ids) |
| `DELETE /api/auth/me` | JWT | → 204. Erasure, cascades |
| `GET /api/auth/me/export` | JWT | → JSON of everything stored about the user |
| `POST /api/auth/verify/resend` | JWT | → 204 always (§1.13) |
| `GET /api/auth/verify` | link token | Redeems on GET, renders a bilingual result page |
| `POST /api/auth/password/forgot` | — | → 204 always, registered or not |
| `GET/POST /api/auth/password/reset` | link token | Browser form; redeems on POST |
| `GET /api/alerts/recent` | JWT | `AlertDTO[]`, 48 h window, 100 max, newest first |
| `POST /api/alerts/submit-data` | `X-Api-Key` | Manual injection; same store-then-notify path as ingestion |
| `POST /api/alerts/test-push` | `X-Api-Key` | Raw push to one user or everyone; stores nothing (§1.6) |
| `GET /api/preferences` | JWT | `[{category, label, isEnabled}]` for all four categories, default enabled |
| `PUT /api/preferences/{category}` | JWT | `{isEnabled}` → 204; unknown category → 400 |
| `GET /api/preferences/bus-lines` | JWT | `{available, selected}` |
| `PUT /api/preferences/bus-lines` | JWT | `{busLines}` → 204; unknown line → 400 |
| `GET /privacy` | — | Bilingual privacy policy (§2.5) |

`AlertDTO`: `{id, original_message:{title, content}, processed_data:{locations,
start_time, end_time, windows}, source, severity, created_at}`, where each
location is `{location_name, sublocations, is_polygon, polygon_geojson?, lat?,
lng?}`. `windows` is `{from_date, to_date, daily:[{start, end}]}` or `null` —
non-null only when the `start_time`/`end_time` envelope loses detail (§1.7), so a
client that ignores it keeps today's behaviour.

**Categories** (`shared/constants.ts`): `vik` (Water/ВиК), `vt` (Traffic),
`epro` (Power/ЕРП Север), `heating` (Heating/Веолия). Adding a source means
adding an entry here and nothing schema-level. `core/bus-lines.ts` carries the
catalog verbatim, including the Cyrillic А→A / Б→B normalization and the `"0"`
sentinel.

**Sessions.** The access token is a 60-minute HS256 JWT (`sub`, `email`, `iss`,
`aud` checked on verify); the app treats it as opaque. Because an HS256 JWT
cannot be revoked, the durable session is a **rotating refresh token** row
(`core/refresh-tokens.ts`): 32 random bytes, only its SHA-256 stored, single-use,
sliding **90-day** expiry, one `family_id` per device. Redeeming claims the row
in a single `UPDATE … RETURNING`, so two concurrent refreshes from one device
cannot both rotate. Replaying an already-spent token means two parties hold the
chain, so that **family** is deleted — one device signs in again, the account's
other sessions are untouched. A password reset revokes every family.

**Passwords** (`core/password.ts`): PBKDF2-SHA-256, **100,000 iterations**
(workerd's cap), 16-byte salt, self-describing
`pbkdf2$sha256$<iters>$<saltB64>$<hashB64>` so iterations can be raised with a
lazy rehash later. BCrypt cannot run inside the 10 ms CPU budget.

**Rate limiting** (`api/rate-limit.ts`, Cloudflare's Rate Limiting binding).
Counters are per-Cloudflare-location and documented as permissive and eventually
consistent, so these are an abuse dampener, never the only control. Keyed on
`CF-Connecting-IP` (edge-written, unspoofable) and they **fail open** — a limiter
outage must not take down login:

| Limiter | Limit / 60 s | Key | Guards |
|---|---|---|---|
| `RL_LOGIN_IP` | 20 | IP | One host grinding many accounts |
| `RL_LOGIN_EMAIL` | 10 | email | Many hosts grinding one account |
| `RL_REGISTER_IP` | 5 | IP | Signup spam, enumeration at scale |
| `RL_REFRESH_IP` | 30 | IP | Own bucket, so hourly renewals behind carrier NAT can't throttle sign-ins |
| `RL_GEOCODE_USER` | 5 | user | Every location write is an outbound Nominatim call (§2.2) |
| `RL_EMAIL_IP` / `RL_EMAIL_ADDR` | 5 / 2 | IP / address (user id on `verify/resend`) | Mail-sending routes, both directions of mailbombing |
| `RL_API_IP` | 120 | IP | Blanket backstop under `/api/*` (not `/privacy`) |

Two separate login keys, because one key catches neither attack: password
spraying varies the email and a botnet varies the IP, so a composite `(email,ip)`
key put every attempt in a fresh bucket.

**Deliberate disclosures.** `/register` returns 409 on a duplicate, and `/login`
answers an unknown address without paying for PBKDF2 — both reveal that an
address exists. Kept: the usual fix (hashing a dummy password on the miss path)
turns every junk login into 100,000 rounds of work an attacker chooses to spend
on our CPU budget. `/password/forgot` and `/verify/resend` stay neutral so they
add no *second*, unthrottled oracle.

**Errors and config.** `onError` returns a uniform
`{"error":"An unexpected error occurred."}` 500 with no stack trace.
`assertConfig(env)` runs as the first middleware and refuses to serve when
`JWT_KEY` is missing or shorter than 32 chars, or `INGEST_API_KEY` is unset —
the Worker equivalent of a startup guard.

**Feed caching.** `/api/alerts/recent` is identical for every authenticated
caller, so the response is stored in the Cache API for 60 s under a
user-independent key. `requireAuth` still runs on every request; only the D1 read
is cached. Without it, row reads scale with clients × poll rate (100 rows a
poll); with it they scale with time. Ingest runs on a 15-minute cron, so 60 s is
well inside the source's own latency.

**Background work.** `api/background.ts#detach` wraps `waitUntil` and tolerates
its absence (tests, direct `app.request` calls), so a best-effort side task —
sending mail, warming the feed cache — can never 500 the endpoint that scheduled
it.

### 1.5 Alert service (`core/alert-service.ts`)

**`storeAlert`** enriches the locations, then inserts the row. Severity comes
from a fixed map (`vik`/`epro`/`heating` → `warning`, `vt` → `info`, unknown →
`info`). Storing happens **before** notifying, always: a store failure returns an
error the caller can safely retry, because no push has gone out yet.

**Idempotency.** Cursor-driven alerts carry `source_ref = "<category>:<msgRef>"`
(e.g. `vik:id=17148`) — category-prefixed because two sources can share a numeric
id. A re-driven message finds its existing row instead of duplicating it. Manual
`/submit-data` injections pass `null` and always store fresh. `notified_at`
records that the push landed; `push_attempts` counts failures (§1.7).

**Location enrichment.** For each raw location:

- `polygon_geojson` is normalized to a bare GeoJSON geometry (a FeatureCollection
  or a bare geometry are both accepted), and the outer ring's centroid becomes
  the pin. If a polygon was requested but not built, `is_polygon` is forced back
  to `false`.
- Otherwise coordinates are resolved **region-first**: a named district/locality
  usually lists several streets inside it, and pinning one of those reads as "the
  outage is *here*" when it spans the whole area. Streets are the fallback (first
  three sublocations, first hit wins).
- `region_wide` (guard A6, §1.7) is carried onto the DTO when set, so a stored
  alert records *why* its targeting was region-wide despite naming streets. The
  app ignores it; the review tool badges it.
- Each candidate name is first matched against our own tables (§1.3's kind-aware
  matcher for regions, `matchStreet` for streets). A matched row with seeded
  coordinates (migration 0005) needs **no network call at all** — which keeps
  Nominatim's 1,100 ms throttle and 8 s timeout off the ingest budget on the
  common path. Unseeded names fall back to Nominatim with the written kind
  stripped by `parseName`.
- Nominatim hits that name an *object* rather than a place are skipped
  (`amenity`, `shop`, `office`, `tourism`, `historic`, `railway`, … and the
  point-like `highway` types). OSM tags a bus shelter with the same `name` as the
  area around it, and Nominatim ranked one first: an outage across five Provadia
  villages was pinned on the shelter `Вилна зона /Виница/` in Варна. The query
  asks for five results and takes the first that is a place; a street is still a
  place, so street geocoding is unaffected.

Enrichment never throws: an alert without coordinates is still worth storing.

**Targeting** (`sendUsersNotification`) — the decision tree, in order:

1. **Locations present** → per location: polygon → bbox + ray-cast (§1.3);
   otherwise a kind-aware region match, and street matches resolved
   **independently of the region** (scraped alerts often name only a street, and
   `street_name` is globally unique, so an unmatched region must not discard a
   good street match). All matched streets resolve in one query. No usable
   street → region-wide; unknown region too → nobody.
   A location marked `region_wide` (guard A6, §1.7) skips the street branch
   entirely — but only if a region resolved, since there is no street→region link
   to widen through otherwise.
2. **No locations and `city_wide === false`** → **store only, never broadcast.**
   The scraper explicitly said this is not city-wide yet produced no locations,
   which is almost certainly an LLM misparse of a street-level outage. This guard
   is load-bearing; do not "simplify" it.
3. **No locations, `city_wide` true or absent** → everyone.
4. **`bus_lines` present** → drop users who picked lines and none of them match.
   Users with no selection have no filter and stay in the audience.
5. Add `receives_all_alerts` users, dedupe, then drop users who opted out of the
   category.

**Push body**: the content plus a rendered time window (`27.07 08:00 – 17:00`),
truncated at 1,000 characters with an ellipsis.

**`getRecentAlerts`**: 48 hours, 100 rows, newest first; a corrupt
`locations_json` degrades that alert to `[]` rather than failing the feed.

**Nominatim client (`core/geocoding.ts`).** Forward lookups are cached in D1
(`geocode_cache`), **misses included**, so a repeatedly unresolvable name is
asked once. Both directions pass through the same slot reservation: a promise
chain that spaces outbound calls ≥1,100 ms apart. It is a chain rather than a
timestamp check because two concurrent callers reading the same timestamp both
waited the same interval and then fired simultaneously — exactly the 1 rps breach
the throttle exists to prevent. A reservation that would not fit inside the
caller's deadline is refused: a skipped geocode beats sleeping into a mid-flight
kill. Requests carry the descriptive `User-Agent` OSMF's policy requires and time
out at 8 s. Reverse geocoding returns *every* populated address level, most
specific first (`suburb`, `neighbourhood`, `quarter`, `city_district`, `city`,
`town`, `village`), because Nominatim labels the same place at several
granularities and only some of them exist in our tables — returning one name
meant central Varna matched nothing at all.

### 1.6 Push delivery (`core/onesignal.ts`)

`POST https://api.onesignal.com/notifications`, header
`Authorization: Key <ONESIGNAL_API_KEY>`, body
`{app_id, target_channel:"push", include_aliases:{external_id:[…]}, headings,
contents, data}` with all `data` values strings (`category`, `startTime`,
`endTime`). The `external_id` is our own `user_id`: the app sets it with
`OneSignal.login()` on sign-in and clears it with `OneSignal.logout()`.

Audiences are chunked at **2,000 aliases** per call (the documented
`include_aliases` cap) and chunks are sent concurrently, so cost is
`⌈users/2000⌉` subrequests — a single invocation's 50-subrequest budget covers
100,000 users. Sends time out at 10 s.

**Why not FCM directly:** FCM v1 has no multicast endpoint, so the original
client spent one subrequest *per device* and chained self-invocations through an
internal route to get past the ceiling. Fan-out cost grew with the device count
and the chain was serial. That was the scaling wall; OneSignal fans out on its
own infrastructure.

**Targeting stays entirely ours** (§1.5). Polygon ray-casting and trigram name
matching cannot be expressed as OneSignal segment filters, and keeping them here
means the provider only ever receives the ids of users we already decided to
notify — never a location.

**No `device_tokens` table and no stale-token handling** (dropped in 0008).
OneSignal owns device registrations and their unsubscribe lifecycle; a 200 that
reports unknown aliases is normal churn — logged, ignored, and explicitly *not* a
retryable failure.

**Result semantics.** `sendPushToUsers` never throws. It returns
`{sent, failed, ok}`, where `ok` is false **only** for a retryable transport
failure (network, timeout, non-2xx) on a non-empty audience. An empty audience,
absent credentials, or a 200 reaching zero live devices are all `ok: true` —
retrying those would pin the ingest cursor forever. `sent` counts *devices*
(OneSignal's `recipients`), so `failed` is clamped at zero.

**Missing credentials degrade, never fail:** without `ONESIGNAL_API_KEY` /
`ONESIGNAL_APP_ID` the sender warns and skips.

**Delivery check.** `POST /api/alerts/test-push` (ingest-key gated) takes
`{title, body, userId?}` and sends a raw push to that one `external_id` or to
every registered user, bypassing all targeting and preference filters —
deliberately, since those are exactly what would silently swallow a delivery
test. Nothing is stored, so a test push never appears in `/api/alerts/recent`.

### 1.7 Ingestion (`ingestion/`)

**Scheduling.** One cron (`*/15 * * * *`) wakes the Worker; `schedule.ts` decides
which sources are due, from wall-clock time alone — no state row, survives
restarts, at the cost of a phase fixed to the epoch:

| Source | Interval | Why |
|---|---|---|
| `vik` | 15 min | Several outages a day |
| `epro` | 15 min | Planned + unplanned power cuts, moderately chatty |
| `vt` | 4 h | Route changes; a few a week |
| `heating` | 4 h | A handful a month outside the heating season |

15 minutes is the GCD of those intervals, so no source is polled more often than
it asks for and the Worker never wakes for nothing. A source's index in the
source list is its stagger phase, so sources sharing an interval land on
different ticks; the *run order* additionally rotates by tick number so a slow
source cannot starve the others.

**Time budget.** `DEADLINE_MS = 180_000`. The plan originally assumed a 30 s
wall-clock cap on sub-hourly crons; that is wrong — only CPU is capped, and the
AI/Overpass/Nominatim hops are all I/O. The budget exists so a tick finishes well
inside the 15-minute cadence and the next tick never overlaps it (the cursor
model assumes one writer per source). 180 s gives a qwen3 parse (4–21 s, plus
retries) room to complete without raising the per-tick message cap. Every source
gets the deadline threaded in *and* is wrapped in `withTimeout` as a
belt-and-braces guard.

**Cursor semantics** — ported verbatim from the Python crawler, and load-bearing:

- Process **oldest-first**; advance the cursor only past **successes**.
- A failed message **blocks newer ones**, so a retried run cannot re-notify.
- A persistently failing message ages off the listing (and, for pushes, is
  abandoned after `MAX_PUSH_ATTEMPTS = 3`, see below).
- **Persist per success, not per batch.** A trailing write never runs when the
  invocation is killed mid-batch — and it routinely is, because the next
  message's AI parse can burn the remaining budget. The already-notified message
  then looks new on every following tick and is re-stored and re-pushed until the
  cursor finally advances.
- **First-run bootstrap:** with an empty `crawl_state` row, each source
  initializes to the currently published state *without processing* — otherwise a
  fresh deploy would push-notify the entire visible history of every source. An
  unreadable cursor or seen-set skips the tick rather than being treated as zero,
  for the same reason.
- **Max 2 new messages per source per tick** (`MAX_MESSAGES_PER_TICK`); seen-id
  sets are capped at 500 ids (`MAX_SEEN_IDS`).

**Three crawler shapes:**

| Shape | Used by | Mechanics |
|---|---|---|
| **id-probe** (`sources/id-probe.ts`) | `vik` | Walks `<base><id>.html` forward from the cursor. vikvarna answers *every* id with 200 — an empty id renders the listing shell — so "nothing here" is a parse result, not a status code, and the walk stops after **3 consecutive misses**. A fetch error is never counted as a miss (a 503 must not look like the end of the queue). Escape hatch: if the cursor has been stuck for **6 h** with nothing probeable above it, the listing is consulted once and the cursor steps over the dead run |
| **id-listing** (`sources/id-listing.ts`) | `heating` | Parses the listing, takes ids above the cursor, processes oldest-first |
| **seen-ids** | `epro`, `vt` | No stable ids: `epro` hashes `period|text` to 24 hex chars (SHA-256), `vt` uses the accordion's `data-id` or a SHA-1 of the content |

**Why ViK probes instead of following the listing:** vikvarna's listing page only
exists filtered by region, and the URL previously walked was the *city* of Varna
alone — outages in Devnya, Provadia, Dolni Chiflik and Dalgopol were never seen.
The message pages are not filtered: `<base><id>.html`, query-string-free, serves
the message whatever region it belongs to. The same id space also holds **planned
repairs**, so ViK now ingests those too — an intended widening; a planned shut-off
leaves a street just as dry.

**Per-source notes:**

| Source | Notes |
|---|---|
| `vik` | ViK Varna. Municipality-wide via id-probe; the listing only seeds the cursor or unwedges it |
| `heating` | Veolia Energy Varna. `/node/(\d+)` links, base-URL-relative |
| `epro` | ERP Sever JSON XHR (`X-Requested-With: XMLHttpRequest`). **Contract changed since the original port:** the parameterless call returns the area list with every bucket empty; entries come back only for a queried `region_id` + `type`, inside `area_locations`. Both active types (`for_next_48_hours`, `all_active`) are queried and de-duplicated by content; every type failing returns "couldn't read", not "nothing there" |
| `vt` | VarnaTraffic accordion → LLM bus-line extraction → city-wide `vt` alert narrowed by §1.5's bus-line filter. `null` = irrelevant (marked seen, skipped), `["0"]` = a route change with no line named (full audience). Named lines are appended to the content as `Засегнати линии: …` |

**Pipeline** (`pipeline.ts`) for outage-style messages (`vik`, `epro`,
`heating`): AI parse → zod → schedule normalization → **deterministic guards** →
polygons → `ingestAlert`.

**The guards (`ingestion/normalize.ts`)** are a pure module decided from the
source text and the seeded rows, never from what the model happened to emit.
The prompt carries the same rules (§1.8), but the prompt is nondeterministic and
these are not, so this is what actually holds. Each one answers a failure found
in production output:

| | Rule | What it fixes |
|---|---|---|
| A1 | A bare kind (`м-т`, `местност`), a generic noun (`карето`, `зона`) or a shop/company/substation (`м-н …`, `… ООД`, `ТП 726`) is not a place — drop it before enrichment | The matcher always answers with *something*: `м-т` scored 0.364 on `м-т Фичоза` and pinned five villages' outage 40 km away |
| A2 | A polygon cue in the message (`карето`, `затворени`, `между`) plus ≥3 sublocations forces `is_polygon`, whatever the model said | The pin fell back to the first street's centroid, 1.4 km off |
| A3 | A lone `Варна` only becomes `city_wide` when the message *says* city-wide (`всички абонати`, `цялата Варна`, …) | The guard fired on the same shape a **dropped district** produces, and `city_wide` fans out via `getAllUserIds` — five extraction failures were broadcast to every user |
| A4 | A sublocation carrying a region kind, ending in `зона`, or (under a bare city parent) matching a region row, is lifted out into a location of its own; the city before epro's `гр. X - кв. Y` dash is context and is dropped | The flat `(location_name, sublocations)` schema has no slot for that shape, so the district landed in the street array and targeted nobody |
| A5 | Trailing house/block/entrance detail is stripped from `ул.`/`бул.` names (`ул. Пловдив 25` → `ул. Пловдив`), never when the strip would empty the core (`ул.7` is a truncated ordinal) | House numbers dragged the street match around |
| A6 | An area cue in the message (`в района на`, `района около`, `прилежащите улици`, `в близост до`, `околните/съседните улици`) plus ≥1 street sets `region_wide` on the location | The streets in a hedged message say *where* the outage is, not who is in it — targeting only those exact streets asserted a precision the source never gave, and missed the resident one street over |

**A6 changes targeting only.** The street list stays on the location, so the feed,
the pin and the review tool still show the most specific thing the message said;
what widens is `getUserIdsInRange`, which takes the region branch instead of the
street branch. It is deliberately conditional on a region having *resolved*: vik
routinely names streets and no district at all, and there is no street→region link
in the schema to recover one, so with nothing to widen to the named streets remain
a better audience than nobody. A2 wins over A6 — a `карето` block is the more
specific claim, and a bounded shape is exactly what A6 declines to assert.

Both cues are read once per message, so a hedge marks every location the message
produced. The sources publish one outage per message, so that is the right grain.

A3 is what remains of the original city-wide guard, a deterministic fix for a
known model deviation (§1.8): roughly one run in five, qwen3 emits a single
location `град Варна` instead of `city_wide: true` with an empty list. The shape
is the same either way — what tells the two apart is the message.

**Times** come back from the model as a `schedule` object — a date range plus the
clock windows inside it — because a flat start/end pair could express neither
shape the sources publish: `От 30.07 до 31.07 В периода 8:30 до 17:00` means
08:30–17:00 *on each day* (stored flat, it read as 55 continuous hours), and
`от 9 до 11 и от 15 до 17` is two windows in one day (stored flat, 09:00–17:00).
`normalizeSchedule` (`shared/datetime.ts`) derives `start_time`/`end_time` as the
**envelope** — first date at the first start clock, last date at the last end —
and stores the detail in `windows_json` only when the envelope loses some. Asking
the model for both a schedule and a pair would invite it to contradict itself, so
the pair is never requested. The prompt is prefixed with a `CURRENT_DATE:` line
pinned to the Sofia calendar day, and every field is coerced or rejected here — a
malformed value degrades to "no time", never to a wrong window. Times carry no
offset on purpose: the audience is in Bulgaria, so
`new Date("2026-07-27T08:00:00")` parses correctly in device-local time.
- Polygon building is skipped when under **6 s** of budget remain — a polygon is
  an enhancement, storing and notifying is not.
- `ingestAlert` returns true only once the alert is stored **and** its push has
  landed or is owed to nobody. A failed send holds the cursor so the next tick
  re-drives the message (the re-store is a no-op via `source_ref`, and
  `notified_at` is still unset, so the push retries without duplicating the
  alert). After **3** failed attempts it gives up and lets the cursor advance;
  the alert stays stored and is findable as abandoned (`notified_at IS NULL` with
  `push_attempts` at the cap).

**Scrape client (`scrape.ts`)**: browser-like `DEFAULT_HEADERS`, deadline-aware
`AbortSignal`, retry on 429/5xx, plus the cheerio parsers for each source, all
asserted against fixture HTML in `test/fixtures/`.

**Daily cleanup** (`30 3 * * *`) runs independent jobs — one failure must not
skip the rest, because retention deletions that silently stop are how a 500 MB D1
fills up:

| Job | Cutoff |
|---|---|
| `alerts` | 90 days |
| `geocode_cache` | 180 days |
| `auth_tokens` (expired) | 1 day past expiry (so an "already used" click still lands on a sensible page) |
| `refresh_tokens` (expired) | at expiry |
| `refresh_tokens` (spent) | 7 days, so replay detection still recognizes a leaked chain |

### 1.8 Workers AI (`ingestion/ai.ts`)

`env.AI.run(env.AI_MODEL, {messages, response_format:{type:"json_schema",
json_schema}, max_tokens: 8000})`, three attempts with linear backoff, `null` on
any failure — the source then skips the message and retries next tick.

- **Model: `@cf/qwen/qwen3-30b-a3b-fp8`**, a `vars` entry so it can be swapped
  without a code change. It was the only Phase 0 candidate that both supports
  JSON-schema mode and handles nullable type unions, and it is also the cheapest
  (`spikes/RESULTS.md`): `llama-3.1-8b-instruct-fp8` rejects JSON schemas
  outright (error 5025), and `llama-3.3-70b-instruct-fp8-fast` fails on
  `"type":["string","null"]` (error 5024), which all three production schemas
  use.
- **`max_tokens: 8000`** is required: qwen3 is a reasoning model and at the
  default 2,000 it burns the budget thinking and returns no JSON.
- The AI binding accepts no `AbortSignal`, so each run is wrapped in a **30 s**
  timeout (legitimate parses clock 4–21 s), bounded further by the remaining tick
  deadline. Starting an inference that cannot be waited out only burns neurons.
- Zod schemas mirror the original Pydantic models, including fields hidden from
  the model: `polygon_geojson` and `bus_lines` are excluded from the generated
  JSON schema and widened after parsing (the `SkipJsonSchema` trick).
- **Prompts are copied character-for-character** into `shared/constants.ts` and
  are tuned for Bulgarian abbreviation handling. Do not "improve" them during
  maintenance. The one deliberate divergence from the original is time handling
  (ISO datetimes instead of bare `HH:MM`, §1.7).
- Budget: tens of messages a day at ~1–2k tokens each, comfortably inside 10,000
  neurons/day. If the cap is ever hit, `AI.run` fails, the cursor holds, and the
  messages are processed after the 00:00 UTC reset — acceptable degradation, no
  code needed.
- Optional: route calls through a free **AI Gateway** for request logs and replay.

### 1.9 Polygon builder (`ingestion/polygon.ts`)

For a location the model marked `is_polygon: true`, I/O and CPU are deliberately
separated:

1. **Resolve street names** against the `streets` table at threshold **0.4**.
   Fewer than three resolved → log and return `null`.
2. **Fetch geometries** with one Overpass QL query:
   `area["name"="Варна"]["boundary"="administrative"]` → `way(area.a)["highway"]
   ["name"~"^(…)$"]` → `out geom`. Names are escaped twice — regex metacharacters
   (a real seeded name is `Боровец-юг 9-та (бул. Тих кът)`) and the double quote,
   which would otherwise close the Overpass string literal. Responses are cached
   in module memory (50 entries) keyed by the sorted street list. A **descriptive
   User-Agent is mandatory**: `overpass-api.de` answers a browser UA with 406.
3. **Project** to a local metric frame (equirectangular:
   `x = (lon−lon₀)·111320·cos(lat₀)`, `y = (lat−lat₀)·111320`).
4. **JSTS pipeline:** per-street `LineMerger` → extend both ends by **200 m**
   along the end-segment direction → `UnaryUnionOp` → `Polygonizer`.
5. **Candidate filter:** sample each candidate's exterior ring every **10 m**; a
   street "touches" when a contiguous run longer than **5 m** stays within **1 m**
   of its geometry (distance predicates, not buffer intersections). Keep
   candidates touched by **≥2 distinct streets**, sort by (touch count, area)
   descending, take the winner.
6. **Output** the winner reprojected to WGS84 as a FeatureCollection with a
   `streets` property — the shape enrichment already accepts.
7. Any exception → log and `null`. A polygon failure never fails a message.

**CPU is the binding constraint here** — this is the only meaningfully CPU-heavy
code in the Worker, against a 10 ms free-plan budget. Spike 3 measured 3–7 ms for
block-level street sets but 87 ms at 5 m sampling for a boulevard-heavy set, so
two mitigations are baked in: 10 m sampling (same winners, half the cost) and
clipping street geometries to a bbox with a 500 m margin around the *shortest*
street (kills the blow-up on city-spanning sets). Samples are built once per
candidate rather than once per street per candidate, and an envelope check
rejects distant streets before any distance work. The `$5/mo` Workers Paid plan
(30 s CPU) remains the escape hatch if this is ever exceeded; do not pay
preemptively.

### 1.10 GDPR functionality

- **`DELETE /api/auth/me`** — erasure (Art. 17). One `DELETE FROM users`, cascade
  does the rest; only a non-identifying event is logged. Also a Google Play
  requirement for apps with accounts. Because targeting moved to `external_id`
  aliases, OneSignal — not D1 — holds the account's device registrations, so the
  route also deletes the provider's user record by external id. That call is
  detached: erasure is complete and durable once the row is gone, and a push
  provider being briefly unreachable must not report a failed deletion to
  someone who asked for one.
- **`GET /api/auth/me/export`** — portability (Art. 20). Profile + preferences.
  No device section: push registrations live with OneSignal, keyed by `user_id`.
- **`DELETE /api/auth/location`** — withdraw location consent.
- **Retention jobs** in the daily cron (§1.7).
- **`/privacy`** — a bilingual (BG/EN) policy page served by the Worker itself,
  linked from the app and the Play listing. Contents checklist in §2.5.

### 1.11 Mobile app (`frontend/`)

React Native 0.85 / React 19, Android, React Navigation. Screens: Login,
Register, Home (alert feed + incident map), Notifications (inbox + category
toggles), Profile (account, push permission, location, Privacy & Data).

- **Map**: Leaflet in a WebView over OpenStreetMap tiles; polygons and pins come
  straight from `/api/alerts/recent`. OSM attribution is required and must
  survive WebView changes (§2.6).
- **Push**: OneSignal SDK. Sign-in calls `OneSignal.login(userId)`, sign-out
  calls `logout()`. There is no "register device" step and no Firebase SDK in the
  app — FCM sits *below* OneSignal, configured in their dashboard.
- **Notification inbox** is filled from `/api/alerts/recent`, not from a
  background message handler; dismissals persist locally.
- **Config**: `CITYSHIELD_API_URL` and `ONESIGNAL_APP_ID` are inlined at bundle
  time by `src/config.ts`, which *fails the build* if either is missing from a
  release bundle rather than shipping an app that silently cannot reach the API
  or subscribe to push. `build-apk.bat` carries working defaults for both (both
  are public values).
- **Languages**: Bulgarian and English; dark mode supported.
- **Package name** is still `com.cityshield.fcmtest` (set via `PACKAGE_NAME` in
  `frontend/scripts/build.sh`), and release APKs are signed with the **debug
  keystore, which is committed to this repo** — so anyone holding the repo can
  build an update Android will install over a real one. Both are release
  blockers; see [TODO.md](TODO.md) §5a.

Build and toolchain details: [frontend/SETUP.md](frontend/SETUP.md).

### 1.12 Tests and CI

`vitest` with `@cloudflare/vitest-pool-workers` — tests execute inside workerd
against a real local D1, with Workers AI and outbound `fetch` mocked.
**22 files, 359 tests**, covering: scrape parsers against fixture HTML; the fuzzy
matcher (including Cyrillic cases) and the kind-aware place matcher over the real
collisions from the seed; the deterministic ingestion guards, each against the
parse and source text it was written for; crawler cursor semantics
(retry/blocking, the per-success persistence rule); the alert targeting decision
tree; polygon building against a fixture Overpass response, reproducing the
Python implementation's test point; API contract round-trips; GDPR cascade;
refresh rotation and replay detection; email verification and reset; the seed
upsert; schedule staggering; deadline helpers; datetime and schedule
normalization; and targeting at scale.

`.github/workflows/ci.yml` runs on every push and PR:

| Job | Steps |
|---|---|
| `worker` | `npm ci` → `tsc -p tsconfig.json && tsc -p test/tsconfig.json` → `npm test` → `wrangler deploy --dry-run` (build + 3 MB size check) |
| `app` | `npm ci` → `npm run lint` → `npm run typecheck` |
| `deploy` | On pushes to `main` only, gated on `needs: [worker]` and the `CLOUDFLARE_API_TOKEN` repo secret |

### 1.13 Email verification and password reset

Both flows are built, tested and live in the app; **delivery is mocked** —
`core/mailer.ts` composes each message in full and logs its link instead of
sending it, so nobody can receive one in production. Making it real is a
one-function change plus paperwork (§2.2); the decision it waits on is in
[SETUP.md](SETUP.md).

- `auth_tokens` (migration 0006) holds only the **SHA-256** of each link token,
  scoped by `purpose`, single-use, cascading with the user. Issuing deletes the
  user's previous token of that purpose.
- TTLs: verification **24 h**, reset **1 h**.
- **Verification redeems on GET.** If a mail scanner prefetches the link the
  account simply ends up verified, which is the intended outcome. **Reset does
  not** — a prefetch would burn it before the user saw the form — so `GET`
  renders the form and `POST` redeems, and it redeems *last*, so a rejected form
  can be corrected without a new email.
- Completing a reset also marks the address verified (receiving the mail proves
  control) and revokes **every** refresh token: someone resetting a password may
  be evicting whoever got in, and a 90-day session must not outlive the password
  it was issued against. Access tokens already in flight remain valid for up to
  an hour — that window cannot be revoked.
- Enforcement is **soft**: login works unverified, the app shows a badge and a
  resend row. Revisit only if signup spam appears.
- Mailed links are built from the `SELF_URL` var, never from the request's `Host`
  header — a forged Host would otherwise mail a *working* reset token on a link
  pointing at someone else's server. Falling back to the request origin happens
  only in local dev, and warns.

### 1.14 Budget and risk register

Projected daily usage at pilot scale (500 users, ~20 scraped messages/day):

| Resource | Free limit | Projected | Headroom |
|---|---|---|---|
| Worker requests | 100,000 | ~5k app + ~100 cron | ~20× |
| D1 rows read | 5,000,000 | ~200k (feed reads are edge-cached, §1.4) | ~25× |
| D1 rows written | 100,000 | < 1k | ~100× |
| Workers AI neurons | 10,000 | ~1–3k | ~3–10× |
| Storage | 500 MB/DB | < 50 MB after years (90-day alert retention) | ~10× |

Original risk list, with outcomes:

| # | Risk | Status |
|---|---|---|
| 1 | Source sites blocking Cloudflare egress IPs | **Cleared** — Phase 0 spike 1: all sources returned byte-identical responses from the edge and from a local IP |
| 2 | Cron wall-clock budget | **Restructured** — the 30 s assumption was wrong; only CPU is capped. Bounded by the 15-min cadence instead (§1.7). Worst case is delayed, never lost, alerts |
| 3 | 10 ms CPU on polygon building | **Mitigated** in §1.9 (10 m sampling + bbox clip); the $5/mo plan is the escape hatch |
| 4 | LLM quality on Bulgarian | **Resolved** — qwen3-30b scored 10–11/13 on the graded corpus with 0 errors; the one systematic deviation is handled deterministically (§1.7) |
| 5 | 50-subrequest fan-out ceiling | **Retired** — OneSignal fans out per *user*, 2,000 per request (§1.6) |

Live operational risks worth keeping in view:

- **Source contract drift.** erpsever.bg changed its interruptions API silently
  and epro delivered nothing until it was noticed; vikvarna's listing scoping cost
  the municipality's outlying towns. Both were found by inspection, not by an
  alarm. A source that returns 200 and nothing useful is the failure mode to
  watch for (§3.8).
- **Shared free services.** Overpass and Nominatim rate-limit and shed load; both
  are treated as best-effort, and both degrade to "no polygon"/"no pin".
- **Cron schedule drift.** The Cloudflare schedules API has reported schedules
  that do not match what actually fires; verify with `wrangler tail` (§3.8).

---

## 2. Security, legal and GDPR

CityShield stores real personal data — email, password hash, precise home
location — so GDPR applies in full. The operator is the **data controller**; the
supervisory authority is Bulgaria's **КЗЛД / CPDP** (cpdp.bg).

### 2.1 Personal-data inventory (Art. 30 record)

| Data | Where | Purpose | Lawful basis | Retention |
|---|---|---|---|---|
| Email + password hash | D1 `users` | Account/auth | Contract, Art. 6(1)(b) | Until account deletion |
| Precise lat/lng + region/street | D1 `users` | Location-matched alerts | **Consent**, Art. 6(1)(a) — optional and user-initiated | Until changed or deleted |
| Push registration (device ↔ `user_id`) | **OneSignal**, not our D1 | Push delivery | Contract | Until logout or account deletion |
| Category prefs, bus-line subs | D1 | Feature | Contract | Until account deletion |
| Session rows (hashed refresh tokens) | D1 `refresh_tokens` | Keeping the app signed in | Contract | 90 days sliding; swept by the daily cron |
| Request logs (IP, UA) | Workers Logs | Security/debugging | Legitimate interest, Art. 6(1)(f) | Cloudflare default (~3–7 days); never log bodies with passwords or locations |
| Alert content | D1 `alerts` | Core service | n/a — public utility announcements | 90 days |

No names, no phone numbers, no analytics or tracking SDKs — keep it that way.
Location is the sensitive item and is collected only through the explicit
"set my location" flow.

### 2.2 Processors and international transfers

| Processor | What they see | Paperwork |
|---|---|---|
| **Cloudflare** (Workers/D1/AI) | Everything in transit and at rest | Accept the Cloudflare **DPA** (auto-incorporated in the self-serve terms; keep a copy). EU-US DPF certified, SCCs available. D1 created with `--location=weur` so data at rest sits in Western Europe. Workers AI inputs are alert texts, not personal data |
| **OneSignal** (US) | `user_id` as external id, device push registration, notification content | Accept OneSignal's **DPA**, record its transfer mechanism (DPF or SCCs), list it in the policy. Never receives location, email or preferences |
| **Google / Firebase (FCM)** | The Android delivery channel beneath OneSignal | Accept Google's **Data Processing Terms** in the Firebase console; list Google as a processor |
| **OSM Foundation (Nominatim)** | ⚠️ The user's **precise coordinates** on `PUT /api/auth/location`, and street names during ingest | No DPA exists. Handled by: explicit disclosure and consent in the location flow; requests carrying no user identifier and originating from Cloudflare's IP, not the user's; a link to OSMF's privacy policy. **Documented decision: keep Nominatim and disclose.** A fully clean alternative is self-hosting or a commercial EU geocoder with a DPA |
| **Overpass** (overpass-api.de) | Street names only | No personal data; fair-use compliance only |
| **Mail provider** | Recipient address + message body | **None engaged** — delivery is mocked (§1.13). Before those flows go live: accept the DPA, confirm the processing location, add it to `/privacy` *and* COMPLIANCE.md, and widen the Play Data Safety purpose for email to include Account management |

### 2.3 Data-subject rights

- **Access / portability (Art. 15/20):** `GET /api/auth/me` + `/api/auth/me/export`.
- **Rectification (Art. 16):** location is re-settable in-app; email changes go
  through the support address until an endpoint exists.
- **Erasure (Art. 17):** `DELETE /api/auth/me`, cascading, plus the in-app button.
- **Withdraw consent (location):** `DELETE /api/auth/location`.
- **Objection / restriction:** per-category toggles; support email for the rest.

### 2.4 Security measures (Art. 32)

- TLS everywhere (workers.dev is HTTPS); Android release builds refuse cleartext
  outright — the emulator-loopback exception lives in `src/debug/res/xml` and is
  not part of a release variant.
- PBKDF2 at the platform's maximum iterations, per-user salt, timing-safe
  compare, and the rate limiters in §1.4.
- Bearer credentials — refresh tokens, verification and reset links — are stored
  only as SHA-256 hashes, so a database leak yields nothing replayable.
- Secrets only via `wrangler secret` (`.dev.vars` is gitignored); JWT key ≥48
  random bytes; rotation is re-`put` + redeploy, which also invalidates every
  access token in flight.
- Ingest and test endpoints gated by `INGEST_API_KEY`, compared with
  `crypto.subtle.timingSafeEqual` rather than `===`.
- Response headers on everything served: `Content-Security-Policy`
  (`default-src 'none'` plus inline styles — the browser-facing pages need no
  scripts at all), `Referrer-Policy: no-referrer` so a reset link's token can
  never leave in a `Referer`, `nosniff`, `X-Frame-Options: DENY`, HSTS, and
  `Cache-Control: no-store` unless a route sets its own (only
  `/api/alerts/recent` does, deliberately).
- Every caller-supplied field is length-bounded, including the ones only reached
  on the failure path: an unbounded login password is a way to choose how much
  PBKDF2 the 10 ms CPU budget spends.
- The ingest path treats each source website as hostile: responses are read
  through a 4 MB cap (a slow, endless body cannot be timed out, only bounded),
  and a message URL is fetched only if it resolves to the source's own host — a
  tampered listing must not be able to pick what the Worker retrieves and
  republishes as an outage. A city-wide broadcast, the widest thing ingestion
  can trigger, is logged with its audience size.
- Least privilege: the Firebase service account uploaded to OneSignal carries
  only the FCM role; the OneSignal REST key can send pushes but cannot read
  subscriber data.
- Local tools that can reach production (§3.7) require a per-run token and pin
  `Host` to loopback, so no page open in a browser can POST to them.
- Backups: D1 **Time Travel** gives 7-day point-in-time restore on the free plan.
- **Breach plan (Art. 33/34):** 72-hour notification to the CPDP. The runbook
  lives in [COMPLIANCE.md](COMPLIANCE.md) §4.

### 2.5 Privacy policy, terms and Play Data Safety

`/privacy` is served by the Worker in Bulgarian and English and covers:
controller identity and contact; the §2.1 inventory in prose; purposes and lawful
bases; processors (Cloudflare, OneSignal, Google FCM, OSMF Nominatim) with
transfer safeguards; retention periods; Art. 15–21 rights and how to exercise
them; the right to complain to the CPDP; no automated decision-making with legal
effects; no sale of data; no cookies. Controller contact:
`cityshield.varna@gmail.com`.

The **Google Play Data Safety** answers must stay consistent with it — the filled
table is in COMPLIANCE.md §1. Changing one without the other is itself a Play
policy violation.

No DPO is required (Art. 37 thresholds not met) and no DPIA (no large-scale
systematic monitoring); both conclusions are written up with reasoning in
COMPLIANCE.md §2–3, as Art. 5(2) accountability expects.

### 2.6 Non-GDPR legal items

- **OSM attribution (ODbL):** the Leaflet map must show "© OpenStreetMap
  contributors" — verify it survives WebView changes — and the About screen
  credits Nominatim and Overpass. Mind the OSM **tile usage policy**: if traffic
  grows, move to a provider with a free tier (Carto, Stadia, MapTiler) rather than
  hammering osm.org.
- **Nominatim usage policy:** ≤1 req/s, descriptive User-Agent, caching — all
  satisfied structurally by §1.5. Keep it that way.
- **Scraped sources:** short factual public-safety announcements from official
  operators. Facts are not copyrightable, volumes are trivial, and the EU DSM
  Art. 4 text-and-data-mining exception covers automated extraction; full
  articles are not republished. Keep per-source polling ≥10 minutes, honour any
  `robots.txt` a source adds, and keep the source name visible in the app. If a
  source ever objects, that category is switched off.
- **OneSignal's DPA is new** and must be accepted before release.

---

## 3. Operations

### 3.1 Accounts and credentials

| Item | Status |
|---|---|
| Cloudflare account (`cityshield.varna@gmail.com`), `wrangler login` | Done. Workers AI does **not** work on throwaway preview accounts — a real account is required, but the free plan suffices |
| workers.dev subdomain `cityshield-varna` | Registered |
| OneSignal app (App ID + REST API Key) | Received and installed — App ID in `wrangler.jsonc` vars, REST key as a Worker secret |
| Firebase project | Kept, but only as the FCM channel *beneath* OneSignal; its service-account JSON lives in the OneSignal dashboard, not in our secrets |
| Custom domain | Not registered. Optional (~$10/yr via Cloudflare Registrar); `*.workers.dev` is fine for launch, but a domain is the precondition for real mail (§1.13) |

Secrets (`wrangler secret put`): `JWT_KEY`, `INGEST_API_KEY`,
`ONESIGNAL_API_KEY`. Public vars live in `wrangler.jsonc`; local values go in
`backend/.dev.vars` (copy `.dev.vars.example`, gitignored).

### 3.2 Local development

```sh
cd backend
npm install
npm run db:local     # migrations + generate & load seed data into local D1
npm run dev          # wrangler dev on http://localhost:8787
npm test             # vitest against local D1
npx tsc -p tsconfig.json && npx tsc -p test/tsconfig.json
```

Simulate crons against `wrangler dev`:
`curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"`. **Workers AI calls
from local dev proxy to the real service and consume neurons**, and a local
single-user test push reaches a real phone (§3.7) — "local" describes where the
code runs, not where the side effects go.

On Windows, `setup.bat` in the repo root installs npm packages for both sides and
checks the Android toolchain.

### 3.3 Provisioning a fresh environment

```sh
npx wrangler d1 create cityshield-db --location=weur   # copy database_id into wrangler.jsonc
cd backend && npm run db:remote                        # migrations + seed, --remote
openssl rand -base64 48 | npx wrangler secret put JWT_KEY
openssl rand -hex 32    | npx wrangler secret put INGEST_API_KEY
npx wrangler secret put ONESIGNAL_API_KEY
```

Workers AI needs no provisioning — the `ai` binding is enough. An AI Gateway
named `cityshield` is optional and free (§1.8).

### 3.4 Deploy and verify

```sh
npx wrangler deploy                # prints the workers.dev URL
npx wrangler tail                  # live logs
npx wrangler d1 execute cityshield-db --remote --command "select count(*) from streets"
```

Cron triggers activate on deploy. Post-deploy checks worth repeating: the dropped
routes 404 (`/api/tokens`, `/internal/push-batch`), `/api/alerts/recent` is 401
without a token, `/privacy` serves the current processor list, and
`wrangler d1 migrations list --remote` shows every migration applied.

### 3.5 CI deploys

Dashboard → My Profile → API Tokens → create from the **"Edit Cloudflare
Workers"** template, scoped to the account → add as the GitHub repo secret
`CLOUDFLARE_API_TOKEN`. The `deploy` job (§1.12) then runs on pushes to `main`.

### 3.6 Platform limits to re-check

- Workers limits — developers.cloudflare.com/workers/platform/limits/
- D1 limits and pricing — developers.cloudflare.com/d1/platform/limits/
- Workers AI pricing, models, JSON mode — developers.cloudflare.com/workers-ai/
- Cron triggers — developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare DPA — cloudflare.com/cloudflare-customer-dpa/

### 3.7 Operational tooling

Both tools are local Python web UIs, standard library only, and both print a
tokenized `http://127.0.0.1:<port>/?t=<token>` URL: they can reach production, so
every request must carry a per-run token and `Host` is pinned to loopback against
DNS rebinding.

- **`tools/osm-seed-builder`** (`python tools/osm-seed-builder/app.py`) builds the
  `regions`/`streets` reference data from Overpass. It works inside its own
  gitignored `output/` directory and applies to D1 from there; `backend/seeds/`
  changes only when you press its dedicated merge button. It calls the backend's
  own `generate-seed.mjs`, so the upsert semantics pinned by the test suite are
  the ones applied. A self-hosted Overpass (Bulgaria extract, docker compose in
  `overpass/`) is recommended — the public endpoints rate-limit mid-extract. See
  its README for the five load-bearing compose settings and the Cyrillic filter's
  known lossiness.
- **`tools/alert-review`** (`python tools/alert-review/app.py`) loads what the
  pipeline actually stored — from local or remote D1 — and lets you mark each
  alert accurate / inaccurate / not-implemented, tag shared issues, and write a
  markdown report. It is the measurement behind the ingestion guards (§1.7) and
  the place matcher (§1.3): every rule in those two exists because a review run
  named the alert it got wrong.
- **`tools/push-tester`** (`python tools/push-tester/app.py`) drives
  `POST /api/alerts/test-push` against the local or deployed Worker, addressing
  one user or everyone. The useful trick: load the user list from **remote** D1
  and target the **local** Worker — `sendPushToUsers` never looks an id up in D1,
  so that is a genuine end-to-end delivery test without the deployed ingest key.
  `HTTP 200` with `sent: 0` almost always means the target has never signed in on
  a device, the Worker has no OneSignal credentials, or the deployment hit is not
  the one the phone registered against.

### 3.8 Monitoring and known traps

- **`wrangler tail` is the source of truth for crons.** The Cloudflare schedules
  API has reported schedules that do not match what actually fires. Confirm a
  tick by the `event.cron` value *and* a non-zero CPU time on the invocation —
  which is why the scheduled handler awaits its job instead of using `waitUntil`
  (§1.1).
- **A source that returns 200 and nothing useful is the failure mode to watch.**
  Both real ingestion outages so far (epro's contract change, ViK's region-scoped
  listing) looked healthy in the logs. Periodically compare what the app shows
  against the source websites.
- **D1 Time Travel** (`wrangler d1 time-travel`) gives 7-day point-in-time
  restore on the free plan — the recovery path referenced by the breach runbook.
- Retention deletions log their row counts each night; a cleanup that starts
  reporting zero forever is worth a look before the 500 MB cap is.

---

## 4. History

CityShield originally ran as a Python asyncio ingestion service plus an ASP.NET
Core 8 API over PostgreSQL/PostGIS, with self-hosted Ollama for parsing and the
Firebase Admin SDK for push, deployed with docker-compose behind a reverse proxy.
The migration to a single Cloudflare Worker replaced every server-side component:

| Then | Now |
|---|---|
| PostgreSQL + PostGIS (planned: Neon) | Cloudflare D1 (SQLite), with fuzzy matching and point-in-polygon in TypeScript (§1.3) |
| Ollama (qwen3.5, self-hosted) | Workers AI, JSON-schema mode (§1.8) |
| ASP.NET Core API on a VM | Worker `fetch` handler, Hono (§1.4) |
| Python asyncio polling loops | Worker `scheduled` handler, Cron Triggers (§1.7) |
| Python → API over HTTP (`X-Api-Key`) | Direct function calls inside one Worker |
| Firebase Admin SDK | OneSignal REST API (§1.6) |
| docker-compose + reverse proxy + TLS | `wrangler deploy` |

Merging the two halves removed an HTTP hop, halved the code to maintain, and let
both sides share one database, one geocoding cache and one push client.

The old source tree was deleted from the working tree on 2026-07-25 after the
parity checklist below passed on the Worker side; it remains in git history
(`git log --all -- backend_deprecated/`, last present at commit `026f562`).

**Parity checklist** (the gate for deleting the old code):

| Item | Status |
|---|---|
| Every §1.4 endpoint verified against the app's contract | Covered by the contract tests; app-side flows verified manually |
| All sources ingest real messages end to end | Verified per source at build time; ViK and epro were both re-worked afterwards and are worth re-observing (see TODO.md) |
| A polygon alert notifies only in-polygon users | Tested (bbox + ray-cast targeting) |
| A `city_wide=false` alert with no locations is stored, not broadcast | Tested |
| A `vt` alert respects bus-line filters | Tested |
| Account deletion cascades | Tested |
