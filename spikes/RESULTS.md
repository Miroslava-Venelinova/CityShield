# Phase 0 spike results (PLAN.MD §4)

Ran 2026-07-19. Spike code lives next to this file; all of it is throwaway once Phase 0 sign-off happens.

## Spike 1 — edge fetch of the 5 sources · **PASS** ✅

Deployed `edge-fetch/` to Cloudflare's edge (via `wrangler deploy --temporary` — a claimable
preview account, no login needed) and compared against a local-IP baseline (`check-local.mjs`).

| Target | Local | Cloudflare edge (colo SOF) | Notes |
|---|---|---|---|
| vikvarna.com (vik) | 200, markers OK | 200, byte-identical | |
| varnatraffic.com (vt) | 200, markers OK | 200, byte-identical | |
| erpsever.bg (epro) | 200, JSON + Варна area | 200, byte-identical | the "risky" one — fine |
| energy-varna.bg (heating) | 200, markers OK | 200, byte-identical | |
| api.bg (roads) | 200, markers OK | 200, byte-identical | |
| Nominatim | 200 | 200 | descriptive UA used, per ToS |
| Overpass kumi.systems | timeout | timeout | instance unhealthy from *both* vantage points |
| Overpass overpass-api.de | 200 (descriptive UA) | 200 (descriptive UA) | **browser UA → 406** |

**Verdict: risk #1 (§1.14) is cleared — no source blocks Cloudflare egress; no fetch-proxy fallback needed.**

Actions for implementation:
- `OVERPASS_URL` default should be `https://overpass-api.de/api/interpreter` (not kumi.systems),
  with a fallback instance list; Overpass calls must send a **descriptive User-Agent**, not the
  browser `DEFAULT_HEADERS` (which are still right for the 5 scraped sources).

## Spike 2 — Workers AI model eval · **BLOCKED on Cloudflare login** ⏸

Harness is complete and smoke-tested end-to-end except the model call itself:

- `ai-eval/corpus.json` — 13 graded cases (6 outage incl. polygon/"каре", city-wide guard,
  ж.к./с. abbreviations; 2 roads relevance; 5 vt bus-line cases incl. "209 Бърз"→209B, ["0"]
  sentinel, null-irrelevant), production prompts copied character-for-character.
- `ai-eval/run-eval.mjs` — runs any model list over the corpus with JSON-schema mode, grades
  per-field (bus lines normalized Cyrillic→Latin like `BusLineCatalog.Normalize`), writes a
  JSON report to `ai-eval/out/`.
- Transport A (REST): `CLOUDFLARE_ACCOUNT_ID`+`CLOUDFLARE_API_TOKEN`. Transport B: deployed
  proxy Worker (`ai-eval/worker/`) exposing `env.AI.run` — works, but **Workers AI rejects
  temporary accounts** (`AiError 5034`) for every model, so a real login is required.

Catalog facts verified live (via `env.AI.models()`, July 2026):
- `@cf/meta/llama-3.1-8b-instruct` (plan's cheap candidate) **was deprecated 2026-05-30** →
  candidate list is now: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
  `@cf/meta/llama-3.1-8b-instruct-fp8`, `@cf/qwen/qwen3-30b-a3b-fp8`.
- Pricing (per M tokens in/out): 70b-fast $0.293/$2.253 · 8b-fp8 $0.152/$0.287 ·
  qwen3-30b $0.051/$0.335 — Qwen3 is the cheapest serious candidate and likely strongest on
  Bulgarian; the eval will decide.

**To run:** `npx wrangler login`, then either set the REST env vars, or
`cd spikes/ai-eval/worker && npx wrangler deploy --var EVAL_TOKEN:<random>` and set
`EVAL_WORKER_URL`/`EVAL_TOKEN`, then `node run-eval.mjs`.

## Spike 3 — JSTS polygon builder · **PASS with CPU caveat** ⚠️

`polygon-jsts/` implements the full §1.9 pipeline (Overpass QL → equirectangular projection →
LineMerger → 200 m extension → UnaryUnionOp → Polygonizer → ≥2-touching-streets filter via 5 m
ring sampling) plus the §1.3 trigram fuzzy matcher against `streets.json`.

All four street sets from `polygon.py`'s `__main__` produced closed blocks:

| Set | Result | Warm CPU (5 m sampling) | 10 m sampling |
|---|---|---|---|
| Йовков/Кубрат/Ивац Войвода/Тихомир | 2.98 ha, 4 streets touching | ~14 ms cold / few ms warm | 2.6 ms, same winner |
| Сахаров/Смирненски/Сливница/Цар Освободител | 42.8 ha, 4 streets | **87 ms** | **40 ms**, same winner |
| Варненчик/Младежка/Йовков/Фантазия | 0.49 ha, 3 streets | 3.5 ms | 2.4 ms |
| Русе/Бачо Киро/Козлодуй/Ал. Дякович | 3.17 ha, 4 streets | 6.7 ms | 3.9 ms |

Validation: the known test point (43.22191, 27.88398) is **inside** set 1's block — matching the
Python `__main__` expectation. Fuzzy resolution canonicalized every prefixed/abbreviated name
(e.g. `ул.Ал.Дякович` → `Александър Дякович`). An exact Python-output diff wasn't possible
(no osmnx env on this machine); structural parity is convincing.

**CPU verdict:** typical block-level outages fit the 10 ms budget warm; sets built from several
city-spanning boulevards (set 2: 121 ways for Цар Освободител alone) blow it (40–90 ms), with
the candidate filter dominating. Phase 3 must implement, in order:
1. coarser sampling (10 m — halves cost, identical winner on all 4 sets),
2. clip fetched street geometries to a bbox around the *shortest* street + margin before the
   union (a block polygon is always near the minor street; this kills the boulevard blow-up),
3. if still over budget in `wrangler tail` metrics: Workers Paid ($5/mo, 30 s CPU) — unchanged
   from the plan's escape hatch.

Ingestion runs in the cron handler where the wall-clock allowance is generous; only CPU ms is
the constraint. Also note: Overpass rate-limits aggressive retries (429) — retry with ≥15 s
backoff and cache responses (the spike does both).

## Free-tier numbers re-checked (§3.6, 2026-07-19)

- Workers Free: 100k req/day, 10 ms CPU, 50 subrequests, 3 MB gzipped script — all as planned.
  Cron triggers: docs now say **5 per account** (plan said 3 per Worker) — we use 2, fine either way.
  Cron wall-clock: docs indicate up to 15 min wall for scheduled handlers (CPU still 10 ms) —
  more generous than the ~30 s the plan assumed; keep the 25 s deadline guard anyway.
- D1 Free: 5 GB total / 500 MB per DB, 5M rows read/day, 100k written/day, 50 queries/invocation — as planned.
- Workers AI Free: 10,000 neurons/day — as planned. Model pricing above.

## Phase 0 go/no-go

**GO for Phase 1** (data & API core) — it has no dependency on the one open item.
The open item is the model eval (spike 2), which gates the *Phase 3 cutover model choice*, not
Phase 1/2 work. It needs `npx wrangler login` (§3.1: create the Cloudflare account, enable 2FA),
after which the eval runs in ~5 minutes.
