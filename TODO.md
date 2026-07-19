# CityShield → Cloudflare Migration — TODO

Working checklist for [PLAN.MD](PLAN.MD). Current focus: **Phase 0 — de-risking spikes** (§4).
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
- [ ] Run eval — **blocked: Workers AI rejects temporary accounts (AiError 5034); needs
      `npx wrangler login`**, then ~5 min to run (instructions in spikes/RESULTS.md)
- [ ] Pick cheapest zero-regression model → record decision (final `AI_MODEL` var)

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
- [x] Go/no-go per §1.14 risk list → **GO for Phase 1**; only the model-eval run (gates the
      Phase 3 model choice, not Phase 1/2) waits on `wrangler login`

## Phase 1 — data & API core (break down when started)

- [ ] `worker/` scaffold (wrangler.jsonc, tsconfig, package.json, vitest-pool-workers)
- [ ] D1 migration `0001_init.sql` + seed generator + local apply
- [ ] `core/fuzzy.ts` (pg_trgm-exact trigram similarity) + tests
- [ ] `core/password.ts` (PBKDF2), `core/jwt.ts`, middleware
- [ ] Auth endpoints (register/login/me/location) + tokens + preferences
- [ ] Contract tests against local D1
- [ ] Milestone: RN debug app passes manual auth+prefs flow against `wrangler dev`

## Phase 2 — alerts read/write path

- [ ] alert-service.ts, geo.ts, geocoding + D1 cache, fcm.ts, submit-data + recent

## Phase 3 — ingestion

- [ ] scrape.ts + fixtures, ai.ts, polygon.ts, 5 sources, runner + cron

## Phase 4 — GDPR & polish

- [ ] delete/export/clear-location, /privacy, retention jobs, frontend changes, CI rewrite

## Phase 5 — cutover

- [ ] Release build → Play Store → monitor → decommission per §1.13 parity checklist

## Blocked on user

- [ ] `npx wrangler login` (Cloudflare account, §3.1) — needed for spike deploy, Workers AI eval, D1 provisioning
- [ ] `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (or logged-in wrangler) for the AI eval REST calls
