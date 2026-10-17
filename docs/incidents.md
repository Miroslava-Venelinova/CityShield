# Incidents

Every production failure so far, newest first. Each has the same fields:
symptom, cause, fix, lesson. Most rules in
[design-decisions.md](design-decisions.md) trace back to one of these. To
diagnose something live, start with
[troubleshooting.md](troubleshooting.md).

| Date | What broke | Duration | Found by |
|---|---|---|---|
| 28.08–31.08.2026 | All ingestion: CPU kill in `cheerio.load()` | ~21 h, then fixed 31.08 | A person looking |
| ~13.08–31.08.2026 | heating ingestion only, silently | ~18 days | Found while fixing the 28.08 outage |
| 02.08–10.08.2026 | Seed: 420 streets from other provinces; с. Припек deleted | 8 days | The 08.08 alert review |
| 02.08–09.08.2026 | Every polygon failed, invisibly | 7 days | The 08.08 alert review |
| 30.07.2026 | Tick reached 175.9 of 180 s (near miss) | n/a | `wrangler tail` |
| 29.07–30.07.2026 | All ingestion: CPU kill in the matcher | 20 h | A person looking |
| 23.07.2026 | ViK re-pushed one alert every tick | Until fixed | User reports |
| 21.07.2026 | Cron kept the old schedule after a deploy | ~46 min | `wrangler tail` |
| Before 26.07.2026 | epro delivered nothing after an API change | Unknown | Inspection |
| Before 26.07.2026 | ViK missed outlying towns | Since the original port | Inspection |

The last column is the point: **no alarm caught any of these.** Since 31.08
there is a heartbeat (`GET /api/health`), but nothing pings it yet
([open-questions.md](open-questions.md)).

---

## 28.08.2026: ingest dies again at `exceededCpu` (cheerio)

**Symptom.** From about 17:31 UTC, ticks ended with `outcome: exceededCpu`,
`cpuTime` exactly 10 ms and `logs: []`. The ViK cursor stuck at 17372 while
17373–17375 were published and fetchable. The deployed version (`fe5f0fdd`)
had not changed since 10.08, so no code change triggered it.

**Cause.** `cheerio.load()` ran as one cold synchronous stretch. Measured cold
in Node: 9.8 ms on the ViK listing and 14.4 ms on heating's. workerd is
slower than that. The 30.07 culprit was re-measured and cleared: matcher
`prepare()` cost 0.27 ms, and drift between D1 and the bundled seed was 0.

**Fix** (31.08, `3c5f004`). String scans for the listing pages, and
`HTMLRewriter` for the three parsers that need structure. cheerio was removed
from the Worker, and the bundle shrank from 406 to 252 KB gzipped. The same
deploy added the `ingest_health` heartbeat (0019) and the 5-attempt
pre-store cap (0018). Verified live at 18:00 UTC: `ok` at 53 ms.

**Lessons.**
- The cap bites a **different** burst each time, so re-measure every
  candidate before touching code.
- The 6-hour stall warning added after 30.07 was destroyed by the very
  failure it reported, because a kill discards logs. That is why the heartbeat
  is a D1 row.
- `performance.now()` inside workerd could not measure any of this
  ([findings.md](findings.md#workerds-clock-cannot-time-a-burst)).

## ~13.08.2026: heating silently dead

**Symptom.** The heating cursor sat at 717 while the listing published 718.
Nothing in the logs.

**Cause.** Inferred, not observed: heating's 51 KB listing page grew past the
point where `cheerio.load()` fits in 10 ms. Every heating tick was killed,
while the other sources, on other ticks, carried on.

**Fix.** The same as 28.08. The scrape tests now assert a **byte budget** on
what reaches a parser, so page-size creep fails CI.

**Lesson.** A single source can die while the others look healthy. Since
31.08 the per-source cursor ages are on `/api/health`.

## 02.08–10.08.2026: the province seed was wrong

**Symptom.** Alerts for villages pinned streets in other provinces. `с. Припек`
resolved to Константиново.

**Cause.**
1. The sweep re-resolved each settlement **by name** with no province bound,
   so every same-named settlement nationwide was unioned. As a result, 420 of
   2,974 streets belonged to other towns.
2. The district pass's removal rule retired any row whose *name* it had
   produced under another key. Writing the suburb `("Припек", Константиново)`
   therefore **deleted the village** `("Припек", no parent)`.

**Fix** (10.08). The sweep is keyed by relation id. Parentless rows are
skipped by the removal pass. The "district named like a settlement" refusal
needs proximity (2 km). The seed was re-swept, and both databases wiped and
reseeded with `db:reseed:*`.
[accuracy.md §1](accuracy.md#1-reference-data-the-seed-itself-was-wrong).

**Lessons.** A wrong row is worse than a missing one: it opens the street
gate and targets confidently into another town. And `seed.sql` is an upsert,
so it **never deletes**. A plain `db:remote` would have left all 420 bad rows
in place.

## 02.08–09.08.2026: every polygon failed, and nothing said so

**Symptom.** All 252 stored locations in the window had `is_polygon: false`
and no geometry. The four ★ review notes blamed the model for missing the
`каре` cue.

**Cause.** The guard had fired correctly every time. The **build** failed, for
three reasons: the polygon path compared whole names, so `ул.Никола Вапцаров`
in Горица beat Varna's bare `Никола Вапцаров` and the query matched zero ways;
an OSM spelling variant split one boulevard; and Overpass returned
521/504. Clearing `is_polygon` made a failed build look exactly like a
message without a polygon.

**Fix** (09–10.08). `polygon_failed` and a reason are recorded in
`locations_json`. Street resolution is settlement-scoped through
`matchStreet`, spelling variants are curated, and the build fails over across
Overpass endpoints. Verified live: three of the four ★ alerts now build
rings.

**Lesson.** Record **why** a value is what it is (`polygon_failed`,
`coords_source`). A fallback that leaves no trace makes the failure behind it
invisible.

## 30.07.2026: a tick nearly hit the deadline

**Symptom.** A tick used 175.9 s of the 180 s `DEADLINE_MS`.

**Cause.** `AI.run` had started exceeding its 30 s timeout: 6 timeouts
against 8 messages over three ticks, and retries run one after another.

**Fix.** A stopgap only: `DEADLINE_MS` became 5 min (31.07). The root cause is
unmeasured ([open-questions.md](open-questions.md)).

**Lesson.** Past the deadline the runner silently drops whole sources
(`Deadline reached before '<source>'`). That makes alerts late, not lost, but
only if a later tick has room.

## 29.07–30.07.2026: 20-hour ingest outage (matcher CPU)

**Symptom.** From 29.07 20:45 UTC every tick ended `exceededCpu`, with
`cpuTime` pinned at 10, `wallTime` ~1.4 s, and empty logs. ViK ids
17195–17200, six real outages, were never sent. `vt` kept working, because it
never calls the matchers.

**Cause.** `prepare()` in `place-names.ts` built kinds and trigrams per
candidate on first use, memoised per isolate. A cron tick is a cold isolate
every time, so this cost ~11.6 ms in one burst on **every** tick. It had
worked earlier only because app traffic kept isolates warm.

**Fix** (`5440f27`, `9a5776e`). Grams are packed into numbers, and per-name
data is built at module evaluation from the bundled seed: 11.6 ms → 1.27 ms.

**Lessons.**
- The 10 ms limit bounds a burst, not the invocation. The specification had described it
  wrongly until this incident.
- An `exceededCpu` kill erases the invocation's logs. Read `outcome` before
  you read logs.
- The risk was already written down as "known, unfixed, Workers Paid is the
  escape hatch". It arrived as a silent total outage, not as slow alerts.

## 23.07.2026: one ViK alert re-pushed every tick

**Symptom.** Alert id 17172 was stored and pushed on every 15-minute tick.

**Cause.** `crawlIdListing` wrote the cursor once, **after** the batch loop.
The next message's AI parse used up the budget, `withTimeout` aborted the
source, and the trailing write never ran. The pushed message then looked new
on every tick. The seen-id sources (epro, vt) already persisted per message,
which is why only vik and heating were affected.

**Fix.** The cursor is persisted after every successful message.

**Lesson.** Any write that must happen should happen right after the step it
records. A kill will skip anything left to the end of a batch.

## 21.07.2026: the cron fired the old schedule

**Symptom.** After commit `91fd062` changed the cron from `*/5` to `*/15` and
a deploy landed, the Worker kept firing `*/5` for ~46 minutes. The schedules
API and `wrangler triggers deploy` both reported `*/15` throughout.

**Cause.** The schedules endpoint reports the registered configuration, not
what the scheduler dispatches. Worse, the handler matched exact cron literals,
so an unrecognised `event.cron` returned `ok` with `cpuTime: 0` and no logs:
healthy by every metric.

**Fix.** `npx wrangler triggers deploy`, verified with tail. The handler now
logs loudly on an unrecognised cron.

**Lesson.** `wrangler tail` is the only ground truth for crons. Confirm a
tick by `event.cron` **and** a non-zero `cpuTime`.

## Before 26.07.2026: two source-side outages

- **epro**: erpsever.bg changed its interruptions API without notice. The
  parameterless call started returning empty buckets, so epro delivered
  nothing until someone noticed.
- **ViK**: the crawled listing URL was filtered to the city, so outages in
  Devnya, Provadia, Dolni Chiflik and Dalgopol were never seen. This led to
  the id-probe crawler.

**Lesson.** A source that returns 200 with nothing useful looks healthy in the
logs. Compare the app with the source websites from time to time.
