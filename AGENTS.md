# AGENTS.md

CityShield — real-time utility-outage alerts for Varna, Bulgaria. The server side
is **one TypeScript Cloudflare Worker** (`backend/`) on Cloudflare's free plan;
the client is a React Native Android app (`frontend/`). Sources are ViK (water),
ERP Sever (power), Veolia (heating) and VarnaTraffic.

## Docs

- **[docs/specification.md](docs/specification.md)** — the system *as built*, and why. The reference for every
  behaviour question; §1 is the implementation, §2 security/GDPR, §3 operations.
  **Update it in the same change that changes behaviour.**
- **[docs/](docs/README.md)** — everything else. Open these before guessing:
  [design-decisions](docs/design-decisions.md) (what not to undo),
  [troubleshooting](docs/troubleshooting.md) (symptom → cause),
  [runbook](docs/runbook.md) (deploy, reseed, measure),
  [findings](docs/findings.md) (measured facts and dead ends),
  [incidents](docs/incidents.md), [todo](docs/todo.md), [legal](docs/legal.md),
  [open-questions](docs/open-questions.md), [glossary](docs/glossary.md).

Read the relevant specification section before editing a module. Most of the non-obvious
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
  src/core/         alert-service (+ locations, enrichment), fuzzy, place-names,
                    geo, geocoding, onesignal, jwt, password, auth-tokens,
                    refresh-tokens, mailer, bus-lines
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
(HTMLRewriter + string scans) → **AI parse** (Workers AI, JSON-schema mode) → **`normalize.ts`
deterministic guards** → geocode (Nominatim, cached in D1) → build polygon
(Overpass + JSTS) → store → target → push (OneSignal). A daily cleanup cron runs
retention deletions.

A parsed **location is three slots** (`shared/schemas.ts`): `settlement`
(`гр. Варна`), `area` (`кв. Виница`, `ж.к. Младост`) and `streets` — each
independently nullable, the list deliberately flat. One entry is one audience and
one pin.

## Platform constraints that shape the code

- **The 10 ms CPU limit bounds one uninterrupted synchronous stretch**, not the
  invocation — design against the longest burst. Work that depends only on bundled
  data belongs at module scope (separate 400 ms startup budget).
- Per invocation: 50 external subrequests, 50 D1 queries, 100 bound parameters per
  statement. D1 bills rows **examined**, not returned.
- `DEADLINE_MS` (5 min) is threaded through every source: one writer per cursor.
- Module-scope caches are per-isolate and best-effort — nothing may be correct
  only because a cache is warm.
- **A dependency needs a reason.** Runtime: `hono`, `zod`, `jsts`; WebCrypto; no
  ORM. `cheerio` is a devDependency (test oracle) — never import it in `src/`.

## Rules that look like bugs — do not "simplify" them

Each was a real incident; changing one changes who gets woken up. The reasoning
for each is in [docs/design-decisions.md](docs/design-decisions.md).

- **A failed extraction notifies nobody** — bare Варна with no area and no matched
  street reaches nobody. Towns and villages are still audiences by name alone.
- **No locations and `city_wide === false` → store, never broadcast.**
- **An unresolvable settlement scopes to nothing, not to everything**, at every
  call site.
- **Cursors** (`ingestion/state.ts`): oldest-first, advance only past successes,
  **persist per success**, claim the pre-store attempt *before* the work
  (`MAX_PRE_STORE_ATTEMPTS = 5`).
- **Store before notify.** A failed push holds the cursor for 3 attempts.
- **A failed Nominatim lookup leaves `region_id`/`street_id` as they were.**
- **Enrichment never throws**; a polygon failure never fails a message.
- **Guards A1–A15** (`normalize.ts`) each exist for one real message, cited in
  specification §1.7. Several DELETE model output, so a false positive is a silenced alert.
  Order matters (A14 before A2, A15 last); A15 alone adds a place.
- **Only a hedged alert is ever suppressed as a duplicate**, and only against one
  already delivered.
- **Seeded names are Overpass keys** — never reformat one (see Conventions).
- **Prompts are copied verbatim** (`shared/constants.ts`) — don't "improve" them;
  validate any change with `spikes/ai-eval`.
- Deploy **migrations before the Worker that needs them.**

## Conventions

- Every SQL statement lives in `src/db/queries.ts` — nowhere else.
- Seeded region and street names are the **Overpass query keys**. Never
  "normalise" or reformat one; `parseName` already handles the spellings the
  sources actually write (`ЖК`, `ж.к`, `м-ст`, `ул.7`).
- Matching is `core/fuzzy.ts` (a `pg_trgm` port — keep its semantics) plus
  `core/place-names.ts`, which matches on the name's *core* with the kind as a
  filter. Some name variants cannot be learned by similarity and are curated as
  seed aliases instead.
- Comments explain *why*, citing the specification section (`docs/specification.md §1.3`) or the failure
  the rule exists for. Match the density of the file you are in.
- Tests live one-per-module in `backend/test/`, with fixtures for scraped HTML and
  Overpass responses. Cover the bug, not just the fix.
- When tuning a threshold or radius, **sweep a range and report the range** — a
  single value that happens to work is how a 200 m extension became 25 m.
- Never commit secrets. Local values go in `backend/.dev.vars` (gitignored).
- Commits: `type(scope): lowercase subject saying what behaviour changed`.

## Debugging and operations

Moved to [docs/troubleshooting.md](docs/troubleshooting.md) and
[docs/runbook.md](docs/runbook.md). The three things to know without opening them:

- **Read `outcome` before the logs** — an `exceededCpu` kill discards the logs, so
  a killed tick looks like an idle one. `GET /api/health` survives the kill.
- **`wrangler tail` is the only ground truth for crons**; confirm a tick by
  `event.cron` *and* a non-zero `cpuTime`.
- **The remote D1 is not production** (the app is unreleased) — reseeding it is
  routine via `npm run db:reseed:remote`, but never clear `crawl_state`. Local dev
  spends real AI neurons and sends real pushes.

**Branches.** `main` is the only long-lived branch, and **pushing it deploys**
(CI runs `wrangler deploy`). New work starts on its own branch off an
up-to-date `main` (`git checkout -b <type>/<topic>`); merging back is a deploy,
so it waits for the owner's go-ahead. There is no `gh` CLI here: "merge" means
fast-forwarding `main` locally and pushing it.
