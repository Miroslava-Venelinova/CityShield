# Timeline

What happened, in order. Dates are DD.MM.YYYY. Commits are on
`cloudflare-migration` unless noted. Incidents are summarised here and written
up in [incidents.md](incidents.md).

## Before the migration

- **17.01.2026**: CityShield is publicly disclosed at the **"Идейник"** contest,
  under the original architecture. This matters for the invention disclosure;
  see [runbook.md](runbook.md#re-sync-the-invention-disclosure).
- **Original stack**: Python asyncio ingestion, an ASP.NET Core 8 API,
  PostgreSQL + PostGIS + `pg_trgm`, self-hosted Ollama (qwen3.5), and the
  Firebase Admin SDK, deployed with docker-compose behind a reverse proxy.
  [specification §4](specification.md#4-history) maps then → now.

## July 2026: the Cloudflare migration

- **Early July**: the target changes from Google Cloud Run (with Neon for
  Postgres) to **Cloudflare's free plan**, as a single Worker.
- **19.07**: Phase 0 spikes run
  ([RESULTS.md](../backend/spikes/RESULTS.md)). Cloudflare's edge can fetch
  every source; `@cf/qwen/qwen3-30b-a3b-fp8` is chosen; JSTS polygons are
  feasible, with a CPU caveat. `wrangler login` is done on
  `cityshield.varna@gmail.com`.
- **21.07**: the cron schedule drifts after a deploy (incident). The OSM seed
  builder is added. OneSignal credentials are installed. The privacy-policy
  contact address is confirmed.
- **23.07**: ViK re-pushes one alert every tick (incident). The fix: persist
  the cursor after each message.
- **25.07**: the parity checklist passes, and the old source tree is deleted.
  It was last present at `026f562`.
- **26.07**: `PLAN.MD` is replaced by `SPEC.md` (now
  [docs/specification.md](specification.md)), which keeps the same section
  numbers, so code references still resolve. It describes the system as
  built.
- **28.07**: first alert review: **99 alerts, 33 inaccurate (33%)**. This
  produced the deterministic guards, the kind-aware matcher and the schedule
  model (`6deac05`). The fix plan is retired (`1669877`).
- **30.07**: **20-hour ingest outage** from the 10 ms CPU cap (incident). The
  matcher's per-name work moves to module scope. The polygon builder gains
  road bands and burst splitting. The polygon tester is added. The
  extension-length mistake happens and is reverted (see
  [working-practices.md](working-practices.md)).
- **31.07**: `DEADLINE_MS` goes from 180 s to 5 min and AI `max_tokens` to
  10,000 (`921613b`). Migration 0015 gives streets a settlement. City-wide
  alerts are bounded to 15 km (`536efed`).

## August 2026: accuracy

- **02.08 ~13:00 UTC**: **evaluation baseline #1.** Three-level locations and
  repeatable district names (`2f478c8`, migrations 0016–0017) are deployed
  against a province seed of 260 regions, 2,974 streets and 63 settlements.
  The remote `alerts` table is **cleared**, but `crawl_state` is left alone.
  Worker version `0752e410-777d-4377-8994-f84dfc3991ea`.
- **08.08**: review over fresh ingestion: **131 alerts, 16 inaccurate (13%)**
  ([report](../tools/alert-review/reports/review-20260808-213515.md)).
- **09.08**: `DEPLOYMENTS.md` is dropped, and the operator checklist is folded
  into [todo.md](todo.md) §7. Polygon failures become visible
  (`polygon_failed`).
- **10.08**: **the accuracy pass ships**: 19 of 21 fixes
  ([accuracy.md](accuracy.md)). The seed is re-swept by relation id to 350
  regions (177 linked) and 2,565 streets. Both databases are wiped and
  reseeded, and `db:reseed:*` scripts are added (`dffc0a0`). Product ruling:
  **a failed extraction notifies nobody.**
- **10.08 ~17:20 UTC**: **evaluation boundary #2**, Worker version
  `fe5f0fdd-bb89-4a1f-9e81-3ebbbd527f62` (`ae25239`). This time `alerts` was
  **not** cleared, so the table spans two reference datasets. Compare a row's
  `created_on_utc` with this timestamp before blaming the matcher.
- **~13.08**: heating stops ingesting without any error: its 51 KB listing
  page crossed the CPU cap. Nobody notices until 31.08.
- **28.08 ~17:31 UTC**: ingest goes down again, for about 21 hours (incident).
- **29.08**: `AGENTS.md` is written (`e60d589`). §3 of the invention disclosure
  is rewritten for the Cloudflare stack.
- **31.08**: **cheerio is removed from the Worker**. Other changes in that
  deploy: the `ingest_health` heartbeat (migration 0019), and a cap of 5
  attempts on any message that fails before the store (migration 0018). All
  of it is in `3c5f004`. Verified live: `outcome: ok` at 53 ms cpuTime. The
  twelve unresolved `м-т` names are checked and turn out to be unseedable
  ([findings.md](findings.md#places-that-do-not-exist-in-osm-or-nominatim)).

## Since

- **01.09–16.10**: no commits.
- **17.10**: docs reorganised into `docs/`. `SPEC.md` moves to
  `docs/specification.md`; section numbers are unchanged.

## Where the deployment stands (last known, 31.08.2026)

- Worker: `https://cityshield.cityshield-varna.workers.dev`, D1 in `weur`.
- Crons: `*/15 * * * *` (ingest) and `30 3 * * *` (cleanup).
- The app is **unreleased**. The remote D1 is a test bed with fewer than five
  real test accounts.
- `main` still holds the retired pre-Cloudflare stack. Nothing deploys from CI
  until `cloudflare-migration` is merged ([todo.md](todo.md) §1).
