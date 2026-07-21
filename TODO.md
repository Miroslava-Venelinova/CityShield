# CityShield → Cloudflare Migration — TODO

Working checklist for [PLAN.MD](PLAN.MD). **Phases 1–3 + Worker-side Phase 4 are code
complete (2026-07-19, 101 tests green).** Remaining: user-driven milestone checks,
remote provisioning + first deploy, frontend changes, and the Phase 5 cutover.
Tick items as they complete; each phase gets broken into small tasks when we reach it.

## Phase 0 — de-risking spikes

### Spike 1 — edge fetch of the 5 sources (risk #1: Cloudflare egress IPs blocked)

- [x] Scaffold throwaway Worker `spikes/edge-fetch/` that fetches all 5 source URLs
      (browser `DEFAULT_HEADERS` from scrape.py; ePro with `X-Requested-With: XMLHttpRequest`)
      and reports per source: HTTP status, content length, structural markers
      (`#main_content`/`list-item`, `#infoAccordion`/`accordion-group`, ePro JSON + `Варна` area,
      `views-row`/`/node/`, `news-panel`)
- [x] Add Overpass + Nominatim reachability checks to the same spike (they're also edge subrequests)
- [x] Write `check-local.mjs` — same checks run from a local IP as the known-good baseline
- [x] Run local baseline; record results (all 5 sources + Nominatim OK; kumi.systems Overpass down)
- [x] Deploy spike Worker and hit it from the real edge (used `wrangler deploy --temporary` preview
      account — no login needed for the spike)
- [x] Compare edge vs local results → **PASS: no source blocks Cloudflare egress** (byte-identical
      responses). Findings: Overpass needs a descriptive UA (browser UA → 406 on overpass-api.de);
      kumi.systems was down from both vantage points → default `OVERPASS_URL` to overpass-api.de
      + keep a fallback instance

### Spike 2 — Workers AI model eval (risk #4: LLM quality on Bulgarian)

- [x] Build eval corpus `spikes/ai-eval/corpus.json`: 13 graded cases (outage/polygon/city-wide,
      roads relevance, vt bus lines incl. "209 Бърз" and the "0"/null sentinels)
- [x] Write eval runner `spikes/ai-eval/run-eval.mjs` (REST or proxy-Worker transport, JSON-schema
      mode, verbatim prompts, per-field grading) + `worker/` AI proxy + `list-models.mjs`
- [x] Verify live model catalog: plan's cheap candidate `llama-3.1-8b-instruct` was **deprecated
      2026-05-30** → candidates now 70b-fast / `llama-3.1-8b-instruct-fp8` / `qwen3-30b-a3b-fp8`
- [x] Run eval (2026-07-19, real account): qwen3-30b **10–11/13, 0 errors**; both Llama
      candidates disqualified — 8b-fp8 has no JSON-schema support (5025), 70b-fast fails on
      nullable type unions in all our schemas (5024, isolated with minimal schemas)
- [x] Pick model → **`AI_MODEL = @cf/qwen/qwen3-30b-a3b-fp8`** (also cheapest) with
      `max_tokens: 8000` (reasoning headroom). Two deviations for Phase 3 post-processing:
      drops гр./ж.к./с. prefixes from location_name; city-wide guard flakes ~1/5 (emits
      "град Варна" location instead of city_wide:true — deterministically catchable).
      Details in spikes/RESULTS.md

### Spike 3 — JSTS polygon builder (risk #3: 10 ms CPU budget)

- [x] Scaffold `spikes/polygon-jsts/` Node project with `jsts`
- [x] Implement §1.9 pipeline: Overpass QL fetch → equirectangular projection → LineMerger →
      extend 200 m → UnaryUnionOp → Polygonizer → ≥2-touching-streets candidate filter (distance sampling)
      (+ trigram fuzzy resolver against streets.json — spike of `core/fuzzy.ts` too)
- [x] Run against the 4 street sets from `polygon.py`'s `__main__` → 4/4 polygons built;
      fuzzy resolver canonicalizes prefixed names ("ул.Ал.Дякович" → "Александър Дякович")
- [x] Measure pure-CPU time → block-level sets 3–7 ms warm (OK); boulevard-heavy set 2:
      87 ms at 5 m sampling / 40 ms at 10 m (same winner) — **exceeds 10 ms free CPU**;
      filter step dominates → Phase 3 must add bbox clipping and/or coarser sampling; $5 escape hatch stands
- [x] Compare with Python: osmnx env unavailable (Python 3.14, no wheels installed) → structural
      validation instead: set 1 test point (43.22191, 27.88398) inside = true, matches polygon.py `__main__`;
      centroids/areas plausible for all 4 sets
- [x] Record verdict → **PASS with CPU caveat** (details for RESULTS.md)

### Phase 0 wrap-up

- [x] Write `spikes/RESULTS.md` summarizing all three verdicts
- [x] Re-verify free-tier limit numbers against the §3.6 links (all hold; cron triggers now
      5/account; cron wall-clock up to 15 min — CPU 10 ms remains the binding constraint)
- [x] Go/no-go per §1.14 risk list → **GO for Phase 1**
- [x] Phase 0 fully closed 2026-07-19: login done, workers.dev subdomain
      `cityshield-varna.workers.dev` registered, model eval run, spike Worker deleted

## Phase 1 — data & API core

- [x] `worker/` scaffold (wrangler.jsonc, tsconfig, package.json, vitest-pool-workers).
      Note: wrangler pinned to `~4.35.0` — the version `@cloudflare/vitest-pool-workers`
      0.8.71 requires; its workerd caps the local compat date at 2025-09-06 (deploy-side
      2026-07-01 date unaffected)
- [x] D1 migration `0001_init.sql` + `seeds/generate-seed.mjs` + local apply
      (236 regions, 1284 streets in local D1)
- [x] `core/fuzzy.ts` (pg_trgm-exact trigram similarity, promoted from spike 3) + tests
- [x] `core/password.ts` (PBKDF2-SHA256@100k, self-describing format, timing-safe compare),
      `core/jwt.ts` (HS256 via hono/jwt, iss/aud checked), `api/middleware.ts`
      (empty-body 401s, X-Api-Key gate for later phases) + login throttle (10/min/email+ip)
- [x] Auth endpoints (register/login/me/location incl. Nominatim reverse geocode +
      fuzzy region/street match) + tokens (upsert/delete) + preferences (categories +
      bus-lines with Cyrillic normalization)
- [x] Contract tests against local D1 — 37 tests green (`npm test` in worker/): §1.4
      status codes + exact text bodies, camelCase DTO shape, FK cascade for GDPR delete,
      fuzzy/password units; Nominatim mocked via fetchMock
- [x] `wrangler dev` smoke test: register→login→me→location (real Nominatim resolved
      region "Цветен квартал")→prefs→bus-lines (Cyrillic 31а/209Б → 31A/209B)→tokens
- [ ] Milestone: RN debug app passes manual auth+prefs flow against `wrangler dev`
      (needs the app run against `http://<host>:8787` — user-driven check)
- [ ] Provision remote D1 (`wrangler d1 create cityshield-db --location=weur`, paste
      database_id into wrangler.jsonc, apply migration + seed `--remote`, set JWT_KEY +
      INGEST_API_KEY secrets) — deferred until first deploy is needed (Phase 2 milestone)

## Phase 2 — alerts read/write path (code complete 2026-07-19)

- [x] `core/geo.ts` — bbox + ray-cast point-in-polygon (boundary=inside), vertex-average centroid
- [x] `core/geocoding.ts` — forward geocode w/ D1 `geocode_cache` (misses cached too),
      Varna-anchored BuildQuery, ≥1.1 s spacing between uncached Nominatim calls
- [x] `core/fcm.ts` — OAuth2 via WebCrypto RS256, FCM HTTP v1 per-token send, stale-token
      deletion (UNREGISTERED/SENDER_ID_MISMATCH only), >30-token chaining via
      `/internal/push-batch` (fresh subrequest budget per hop)
- [x] `core/alert-service.ts` — full AlertService.cs port: store-before-notify, enrichment
      (FeatureCollection→bare geometry, centroid, fuzzy canonicalize + geocode), targeting
      decision tree (polygon/region+street/city-wide, city_wide=false store-only guard,
      bus-line narrowing, receives_all, preference filter), 1000-char push cap
- [x] `api/alerts.ts` — `POST submit-data` (X-Api-Key; exact 400 error shapes; notify
      failure never fails the request) + `GET recent` (48 h/100, snake_case DTO)
- [x] Tests: 19 new (56 total green) — decision-tree guards from the xUnit suite, polygon
      bbox+ray-cast targeting, geocode cache, FCM send w/ real RS256 signing + stale cleanup
- [x] `wrangler dev` smoke: submit → real Nominatim pin (43.1799, 27.8972 for Народни
      будители) → recent renders the exact app DTO; wrong X-Api-Key → 401
- [ ] Milestone: injecting a test alert via curl produces a push on a real device — needs
      `FCM_SERVICE_ACCOUNT` secret on a deployed Worker + the RN app (user-driven check)

## Phase 3 — ingestion (code complete 2026-07-19)

- [x] `ingestion/scrape.ts` — cheerio port of all 7 parsers; test parity with
      test_scrape.py against the same fixtures; browser headers + 429/5xx retry
- [x] `shared/schemas.ts` + `shared/constants.ts` — 3 prompts character-for-character;
      JSON schemas byte-identical to the validated spike-2 eval; zod backstop with the
      SkipJsonSchema trick (polygon_geojson/bus_lines hidden from the model)
- [x] `ingestion/ai.ts` — JSON-schema mode, `max_tokens: 8000` (qwen3 reasoning headroom),
      3 attempts with backoff, null-on-failure contract
- [x] `ingestion/state.ts` — crawl_state on D1 (cursor + seen-ids capped at 500)
- [x] `ingestion/polygon.ts` — JSTS pipeline from spike 3 with both CPU mitigations
      baked in: 10 m ring sampling + way-level bbox clip around the shortest street;
      fuzzy street resolution at 0.4; Overpass with descriptive UA on overpass-api.de,
      module-memory response cache; fixture test reproduces spike set 1 incl. the
      polygon.py `__main__` test point
- [x] `ingestion/pipeline.ts` — AI → zod → city-wide guard (spike-2 deviation №2:
      lone "град Варна" location normalized to city_wide) → polygons → direct
      ingestAlert (store-first, notify-never-fails)
- [x] 5 sources + `runner.ts` — verbatim cursor semantics (oldest-first, failure blocks,
      per-message seen-id persistence), 2 msgs/source/tick, 25 s deadline, rotating
      start order, roads' extra 5-fetch cap; crons `*/10 * * * *` + `30 3 * * *` wired
- [x] **First-run bootstrap** (new, not in plan): with empty crawl_state each source
      initializes to the current listing WITHOUT processing — otherwise a fresh deploy
      would push-notify the entire visible history of every source
- [x] Live `--test-scheduled` smoke: vik cursor→17147, heating→710, roads 20 seen ids,
      epro row created (0 active interruptions at the time); varnatraffic.com itself was
      returning 503 to everyone (verified from Node too) — crawler logged and moved on,
      which is the designed degradation; re-check VT after deploy
- [ ] Milestone: deployed Worker runs 48 h processing real messages end-to-end
      (needs remote provisioning below)

## Phase 4 — GDPR & polish (Worker side complete 2026-07-19)

- [x] `DELETE /api/auth/me` (cascade erasure), `GET /api/auth/me/export` (portability;
      raw push tokens deliberately excluded), `DELETE /api/auth/location` (consent
      withdrawal) — tested + live-smoked
- [x] `/privacy` — bilingual (BG/EN) policy page served by the Worker covering the §2.5
      checklist; controller contact confirmed as cityshield.varna@gmail.com
      (2026-07-21) — revisit only if a dedicated domain address is set up
- [x] Retention jobs in the daily cron: tokens 60 d, alerts 90 d, geocode cache 180 d
- [x] CI rewrite: `worker` job (typecheck + vitest + dry-run deploy) replaces the
      pytest/dotnet jobs; `app` job kept; `deploy` job on main gated on the
      `CLOUDFLARE_API_TOKEN` repo secret
- [x] Frontend: Profile → "Privacy & Data" section — delete account (two-step confirm,
      Play Store requirement), export data (share sheet), clear location, `/privacy`
      link; Nominatim consent copy in the location-picker modal;
      `CITYSHIELD_API_URL` enforced at bundle time by config.ts
- [x] Written record in [COMPLIANCE.md](COMPLIANCE.md): Play Data Safety answers,
      DPIA + DPO "not required" reasoning (§2.5), Art. 33/34 breach runbook
- [ ] Paperwork (§2.2), operator actions: download Cloudflare DPA copy, accept Google
      DPT in Firebase console, submit the Play Data Safety form per COMPLIANCE.md §1

## Phase 4b — email verification & password reset (beyond PLAN.MD; added 2026-07-21)

- [x] Migration 0006: `users.email_verified_at` + `auth_tokens` (hashed, single-use,
      purpose-scoped, cascading with the user)
- [x] Worker: verification link on signup + `POST /api/auth/verify/resend`,
      `GET /api/auth/verify`; `POST /api/auth/password/forgot` (always 204, no
      enumeration) + `GET|POST /api/auth/password/reset` (browser form, redeems on POST);
      `emailVerified` in `/me` and the GDPR export; expired tokens swept by the daily cron
- [x] Bilingual message composition + `RL_EMAIL_IP` 5/min, `RL_EMAIL_ADDR` 2/min
- [x] App: "Forgot your password?" on the login screen, unverified badge + resend row
      in Profile
- [ ] **Delivery is MOCKED** — `src/core/mailer.ts` logs each link instead of sending it,
      so no user can receive one. Everything else in this phase works end-to-end
- [ ] **Decision parked: mail provider, which follows from "do we register a domain?"**
      A gmail.com sender fails DMARC alignment through any provider and lands in spam.
      With a domain → Resend; without → Brevo from a validated single address. See
      [SETUP.md](SETUP.md) §5. No processor is engaged and none is listed in `/privacy`
      until this is settled — COMPLIANCE.md §5 lists what to update when it is
- [ ] Enforcement stays soft (login works unverified). Revisit only if signup spam appears

## Deploy & remote provisioning (blocks the Phase 3 milestone and Phase 5)

- [ ] `wrangler d1 create cityshield-db --location=weur` → paste database_id into
      wrangler.jsonc → `npm run db:remote`
- [ ] Secrets: `JWT_KEY` (≥48 random bytes), `INGEST_API_KEY`, `FCM_SERVICE_ACCOUNT`
      (JSON at `C:\Users\User\.cityshield\fcm-service-account.json`)
- [ ] `npx wrangler deploy` → set `SELF_URL` var to the workers.dev URL (push-batch
      chaining from cron) → `wrangler tail` sanity watch
- [ ] GitHub repo secret `CLOUDFLARE_API_TOKEN` for the CI deploy job

## Phase 5 — cutover

- [ ] Release build → Play Store → monitor → decommission per §1.13 parity checklist

## Blocked on user

- [x] `npx wrangler login` — done 2026-07-19 (account cityshield.varna@gmail.com,
      id fb1c23b9…, workers.dev subdomain `cityshield-varna`)
- [x] ~~`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` for REST~~ — moot; eval ran through
      the logged-in proxy-Worker transport
- [x] Firebase **service account** JSON key (SETUP.md §2) — received 2026-07-19, validated
      live (OAuth token exchange OK; FCM v1 validate_only send passes auth/permission, i.e.
      the messaging role is present). Stored outside the repo at
      `C:\Users\User\.cityshield\fcm-service-account.json`; becomes the `FCM_SERVICE_ACCOUNT`
      Worker secret via `wrangler secret put` once the Phase 1 Worker exists
- [ ] Android client config for the real app package — the provided `google-services.json`
      is registered to `com.cityshield.fcmtest` (a test app); a config for the real package
      name is needed before Phase 5 release builds
