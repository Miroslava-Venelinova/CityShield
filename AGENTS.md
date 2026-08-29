# AGENTS.md

CityShield — real-time utility-outage alerts for Varna, Bulgaria. The server side
is **one TypeScript Cloudflare Worker** (`backend/`) on Cloudflare's free plan;
the client is a React Native Android app (`frontend/`). Sources are ViK (water),
ERP Sever (power), Veolia (heating) and VarnaTraffic.

## Docs

- **[SPEC.md](SPEC.md)** — the system *as built*, and why. The reference for every
  behaviour question; §1 is the implementation, §2 security/GDPR, §3 operations.
  **Update it in the same change that changes behaviour.**
- [TODO.md](TODO.md) — what is left before release; §7 is the operator checklist.
- [ACCURACY.md](ACCURACY.md) — alert-review findings. [COMPLIANCE.md](COMPLIANCE.md) — the GDPR record.

Read the relevant SPEC section before editing a module. Most of the non-obvious
rules are there because the obvious version broke something, and the section says
which something.

## Layout

```
backend/            the Worker — the entire server side
  wrangler.jsonc    bindings (D1 `DB`, `AI`, 8 rate limiters), crons, vars
  migrations/       D1 SQL migrations
  seeds/            regions/streets/aliases.json + generate-seed.mjs
  src/index.ts      exports { fetch, scheduled }; scheduled dispatches on event.cron
  src/api/          Hono routes, middleware, rate limiting, /privacy
  src/core/         alert-service, fuzzy, place-names, geo, geocoding, onesignal,
                    jwt, password, auth-tokens, refresh-tokens, mailer, bus-lines
  src/db/queries.ts every prepared statement, in one place
  src/ingestion/    runner, schedule, pipeline, normalize, ai, polygon, scrape,
                    state, sources/
  src/shared/       schemas, constants (AI prompts), datetime, deadline
  test/             vitest suite + HTML/Overpass fixtures
frontend/           React Native 0.85 Android app (see frontend/SETUP.md)
tools/              local Python web UIs: osm-seed-builder, alert-review,
                    polygon-tester, push-tester
```

## Commands (from `backend/`)

```sh
npm test                                                   # vitest inside workerd, real local D1
npx tsc -p tsconfig.json && npx tsc -p test/tsconfig.json   # both configs
npm run db:local                                           # migrations + seed into local D1
npm run dev                                                # wrangler dev on :8787
npx wrangler deploy
```

Simulate a cron against `wrangler dev`:
`curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"`.
From `frontend/`: `npm run lint`, `npm run typecheck`. CI runs exactly these, plus
`wrangler deploy --dry-run` to enforce the 3 MB gzipped bundle limit.

## The pipeline, in one pass

`scheduled` (every 15 min) → `schedule.ts` picks the due sources → scrape
(cheerio) → **AI parse** (Workers AI, JSON-schema mode) → **`normalize.ts`
deterministic guards** → geocode (Nominatim, cached in D1) → build polygon
(Overpass + JSTS) → store → target → push (OneSignal). A daily cleanup cron runs
retention deletions.

A parsed **location is three slots** (`shared/schemas.ts`): `settlement`
(`гр. Варна`), `area` (`кв. Виница`, `ж.к. Младост`) and `streets` — each
independently nullable, the list deliberately flat. One entry is one audience and
one pin.

## Platform constraints that shape the code

- **The 10 ms CPU limit bounds one uninterrupted synchronous stretch**, not the
  invocation total. I/O wait is free and a scheduled tick gets minutes of wall
  clock, so design against the longest burst, not the sum. Work that depends only
  on bundled data belongs at module scope, charged against a separate 400 ms
  startup budget.
- Per invocation: 50 external subrequests, 50 D1 queries, 100 bound parameters per
  statement. 5 Cron Triggers per account. D1 bills rows **examined**, not returned.
- `DEADLINE_MS` is 5 min per tick, threaded through every source, so a tick never
  overlaps the next (the cursor model assumes one writer per source).
- Module-scope caches (regions/streets, Overpass responses, the Nominatim slot
  chain) are **per-isolate and best-effort**. Nothing may be correct only because
  a cache is warm.
- **Adding a dependency needs a reason.** The set is `hono`, `zod`, `cheerio`,
  `jsts`. WebCrypto instead of any crypto package; no ORM.

## Rules that look like bugs — do not "simplify" them

Each of these was a real incident. Changing one changes who gets woken up.

- **A failed extraction notifies nobody.** A location resolving to the bare Варна
  row with no area and no matched street is a district that got lost, so it
  reaches nobody rather than the city's ~90 districts. Towns and villages are
  still audiences by name alone; the city is not.
- **No locations and `city_wide === false` → store, never broadcast.** The parser
  said this is not city-wide and produced nothing — almost certainly a misparse of
  a street-level outage.
- **An unresolvable settlement scopes to nothing, not to everything**, at every
  call site. Street names repeat across settlements, so an unscoped match is how a
  village street's outage notified the like-named Varna one.
- **Cursor semantics** (`ingestion/state.ts`): oldest-first, advance only past
  successes, a failed message blocks newer ones, and **persist per success, not
  per batch** — a trailing write never runs when the tick is killed mid-batch, and
  the message is then re-stored and re-pushed every tick until the cursor moves.
- **Store before notify, always**, so a store failure is safely retryable.
  `ingestAlert` returns true only once the push landed or is owed to nobody;
  3 failed attempts then let the cursor advance.
- **A failed Nominatim lookup leaves `region_id`/`street_id` as they were.**
  `ReverseAddress.ok` separates "lookup failed" from "matches nothing" — only a
  completed lookup may clear them. Stale beats blank; those two columns *are* the
  targeting.
- **Enrichment never throws** — an alert without coordinates is still worth storing.
- **The guards A1–A14 (`ingestion/normalize.ts`) each exist for one real message**,
  cited by hash in SPEC.md §1.7. A10 and A12–A14 read a name's *position* in the
  source text and some of them DELETE model output, so a false positive is a
  silenced alert. Order between them matters (A14 runs before A2).
- Deploy **migrations before the Worker that needs them** — a Worker ahead of its
  schema fails every alert it handles.

## Conventions

- Every SQL statement lives in `src/db/queries.ts` — nowhere else.
- Seeded region and street names are the **Overpass query keys**. Never
  "normalise" or reformat one; `parseName` already handles the spellings the
  sources actually write (`ЖК`, `ж.к`, `м-ст`, `ул.7`).
- Matching is `core/fuzzy.ts` (a `pg_trgm` port — keep its semantics) plus
  `core/place-names.ts`, which matches on the name's *core* with the kind as a
  filter. Some name variants cannot be learned by similarity and are curated as
  seed aliases instead.
- Comments explain *why*, citing the SPEC section (`SPEC.md §1.3`) or the failure
  the rule exists for. Match the density of the file you are in.
- Tests live one-per-module in `backend/test/`, with fixtures for scraped HTML and
  Overpass responses. Cover the bug, not just the fix.
- When tuning a threshold or radius, **sweep a range and report the range** — a
  single value that happens to work is how a 200 m extension became 25 m.
- Never commit secrets. Local values go in `backend/.dev.vars` (gitignored).
- Commits: `type(scope): lowercase subject saying what behaviour changed`.

## Debugging

- **`wrangler tail` is the source of truth for crons** — the Cloudflare schedules
  API has reported schedules that do not fire. Confirm a tick by `event.cron`
  *and* a non-zero `cpuTime`.
- **Read `outcome` before the logs.** An `exceededCpu` kill discards the
  invocation's buffered logs, so the tick shows `logs: []` — identical at a glance
  to a tick that had nothing to do. A `cpuTime` sitting exactly on the limit is a
  kill, not a coincidence.
- Grep the tail for `[targeting]` (the per-location audience trace, mirrored by
  `tools/alert-review/targeting.py`), `notified NOBODY`, `has not advanced its
  cursor in N h`, and `Deadline reached before '<source>'`.
- A polygon asked for and not built is recorded as `polygon_failed` in
  `locations_json` — `SELECT` on that key instead of reading a map.
- Historical logs are **not** queryable: the wrangler token lacks the
  observability scope, so catching a live tick with `wrangler tail` is the only
  option, at one data point per 15-minute cron.

## Working notes

- The remote D1 is **not** production — the app is unreleased, so wiping and
  reseeding it is routine: `npm run db:reseed:remote` (`db:remote` deletes nothing).
- Local dev is not a sandbox: Workers AI calls proxy to the real service and spend
  neurons, and a test push reaches a real phone.
- `tools/*` are stdlib-only Python web UIs that can reach production; each run
  prints a tokenized loopback URL and every request must carry that token.
- Work happens on `cloudflare-migration`; `main` still holds the retired
  pre-Cloudflare stack.
