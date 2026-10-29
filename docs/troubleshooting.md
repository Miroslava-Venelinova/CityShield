# Troubleshooting

Symptom first, then cause, then what to do. For problems with the Android app
or its build, see [frontend/SETUP.md](../frontend/SETUP.md#troubleshooting).
Past occurrences of these failures are written up in
[incidents.md](incidents.md).

## Three rules before anything else

1. **Read `outcome` before the logs.** An `exceededCpu` kill discards the
   invocation's logs, so the tick shows `logs: []`, which looks just like a
   tick that had nothing to do. A `cpuTime` sitting exactly at the limit is a
   kill, not a coincidence.
2. **`wrangler tail` is the only ground truth for crons.** The Cloudflare
   schedules API has reported schedules that were not the ones firing.
   Confirm a tick by `event.cron` **and** a non-zero `cpuTime`.
3. **Historical logs cannot be queried.** The wrangler OAuth token lacks the
   observability scope (`10000 Authentication error`), so the only option is
   a live `wrangler tail`, at one data point per 15-minute tick. D1 has the
   history: `ingest_health`, `crawl_state`, `ingest_attempts`, `source_health`, `alerts`.

```sh
cd backend
npx wrangler tail cityshield --format=json          # live ticks
curl -H "X-Api-Key: $INGEST_API_KEY" \
  https://cityshield.cityshield-varna.workers.dev/api/health
```

---

## Ingestion

### No new alerts are arriving
1. Call `GET /api/health`. If `started_at` advances while `completed_at`
   does not, ticks are being **killed** (`exceededCpu`), or ingestion is
   throwing. A thrown tick keeps its logs (`[runner] Ingestion failed` in
   `wrangler tail`); a killed one has none. For a kill, go to the next section.
2. If the heartbeat is fine, check cursors:
   `SELECT source, last_id, updated_at FROM crawl_state`. Then fetch
   `last_id + 1` from the source by hand. If the page exists and parses, the
   fault is ours, downstream of the fetch.
3. Grep the tail for `has not advanced its cursor in N h` (raised after
   6 hours) and `Deadline reached before '<source>'`.
4. If nothing is wrong on our side, the source may have changed. A 200 with
   nothing useful in it is the classic sign (epro's API change, ViK's
   listing). Since 29.10, `/api/health` names such a source in
   `silent_sources`, and its `source_runs` row gives the last outcome
   (`empty`, `parse_error` + what failed, `fetch_error`). The tail says
   `Source '<name>' has found NOTHING for N h`. Compare the app with the
   source website, then the page with its parser in `scrape.ts`.

### Ticks end in `exceededCpu`
A synchronous stretch went over 10 ms. **It has been a different stretch
every time** (the matcher on 30.07, cheerio on 28.08), so do not assume it
is the last culprit again.
- Find the candidates and measure each one cold in Node. Do not use
  `performance.now()` in workerd, which reads zeros
  ([runbook.md](runbook.md#measure-a-cpu-burst)).
- Check for drift between the bundled seed and D1. A remote reseed **without
  a redeploy** sends every name through the slow path: 0.27 ms becomes about
  4 ms for 2,565 streets.
- Check page sizes against the byte budgets in `test/scrape.spec.ts`.
- Do not reach for Workers Paid. More total CPU does not raise the burst
  ceiling.

### One source is stuck and the others are fine
The oldest message keeps failing, and the cursor cannot move past it. Since
31.08 the source is unblocked automatically after 5 attempts (about 75 min).
The skipped message shows up as `GIVING UP on id=…` in the logs, as a row in
`ingest_attempts` with `skipped_at`, and in `/api/health`. If it is still
stuck after that, the failure happens before the attempt is even claimed:
look at the fetch and at reading the cursor.

### The same alert is pushed on every tick
The cursor is not being persisted after a successful message. It must be
written per success, not after the batch ([incidents.md](incidents.md)).
Check that any new crawler follows the same rule.

### Ticks show `cpuTime: 0` and no logs
The cron expression that fired is not one `src/index.ts` dispatches. The
handler logs it as unrecognised. The cause is usually schedule drift after a
deploy. Fix it with `npx wrangler triggers deploy` and verify with tail.

### `Deadline reached before '<source>'`
A tick ran out of its 5-minute budget, almost always because of AI timeouts
(30 s each, retried one after another). The alerts are late, not lost,
provided a later tick has room. Do not raise `RUN_TIMEOUT_MS`.

### AI parsing fails for every message
- After 00:00 UTC the cause may be the neuron cap (10,000 a day). The cursor
  holds and the messages go through after the reset. No action is needed.
- `AiError 5024/5025` means the schema uses a construct the model cannot
  decode. Re-run `spikes/ai-eval/run-eval.mjs`.
- Local dev makes **real** AI calls and spends real neurons.

## Placement and targeting

### An alert "notified NOBODY"
Grep the tail for `[targeting]`. Each location prints its resolved
settlement, its region, and whether each street matched. Then check the
cases in order:
- **Bare Варна with no area and no streets:** this is **by design** (a failed
  extraction notifies nobody). Fix the extraction or add the missing
  district or alias. Do not widen the audience.
- **An area that matched nothing:** if the name is real, add an alias. If it
  is a `м-т` from the unseedable list, there is nothing to seed
  ([findings.md](findings.md#places-that-do-not-exist-in-osm-or-nominatim)).
- **Remote users:** the remote `users` table holds fewer than five test
  accounts, so "nobody" can be literally true. To see the structure of an
  audience, use `tools/alert-review/targeting.py`.

### The pin sits on the city centre
Look at `coords_source` in `locations_json`. `settlement` means a fallback,
not a real location. The place was lost or could not be found.

### A village alert reached a like-named street in Varna, or another town
- First check the seed: `node backend/seeds/verify.mjs`. A street more than
  15 km from its settlement is a polluted row.
- Is the D1 behind the repo? `seed.sql` never deletes. Run
  `npm run db:reseed:remote` ([runbook.md](runbook.md#reseed-a-database)).
- Is any street lookup unscoped? Every street lookup must be scoped to the
  location's settlement.

### A polygon was expected and is missing
`SELECT` on `polygon_failed` / `polygon_failure` in `locations_json`. Then
work through the reason:
- **Fewer than 3 streets resolved:** check the names against the seed for
  that settlement.
- **"the streets enclose no block", with every name resolved:** count the
  ways per name. A single short fragment means an OSM spelling variant,
  which you add to `OSM_NAME_VARIANTS`.
- **`no stored geometry for: <street>`:** the name resolved, but the seed
  holds no way for it in that settlement — it lies outside the settlement's
  boundary, or OSM added or renamed it after the last sweep.
  [Refresh street geometry](runbook.md#refresh-street-geometry).
- **`Overpass HTTP 521/504`** (alerts stored before 26.10.2026 only): the
  builder still fetched geometry live then, and the public endpoint was down.
  It no longer calls Overpass at all.
- **A degenerate ring was rejected:** this is intended. Check it in
  `tools/polygon-tester`.

Alerts stored **before 09.08.2026** do not record polygon failures. Judge
those from the source text.

### A user has coordinates but no region or street
On signup Nominatim was throttled or failed, and that is kept as "no answer"
rather than being written as blank. Sending the location again recovers it.
If the user's place is a `locality`, check that reverse geocoding still asks
for that level.

## Deploys

### `wrangler deploy`: "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN"
The stored OAuth token has expired. Run `npx wrangler whoami`, which
refreshes it silently, then deploy again. Do not create an API token for
this. To check the expiry without printing secrets:

```sh
grep -o 'expiration_time = "[^"]*"' "$APPDATA/xdg.config/.wrangler/config/default.toml"
```

### `api.cloudflare.com` answers 521/522/523 during a deploy
The outage is on Cloudflare's side. Retry in a loop. On 31.07.2026 a deploy
needed 15 retries over about 12 minutes.

### The Worker fails every alert right after a deploy
The Worker was deployed ahead of its migrations. Apply the migrations first,
then deploy. Check with `npx wrangler d1 migrations list --remote`.

### CI fails on the bundle size
`wrangler deploy --dry-run` enforces 3 MB gzipped. Look at what was added.
Every runtime dependency needs a reason.

## Tools

### `push-tester`: `HTTP 200` but `sent: 0`
One of three causes: the user has never signed in on a device; the Worker has
no OneSignal credentials; or you are hitting a different deployment from the
one the phone registered with. Also check the Android package name in the
OneSignal dashboard. A mismatch subscribes the device and then delivers
nothing, silently.

### A tool page answers 403
Every request must carry the per-run token from the printed URL, with `Host`
pinned to `127.0.0.1`. Open the exact URL the tool printed.

### Overpass answers 406 (seed sweep)
You sent a browser User-Agent. Overpass requires a descriptive one.

### `wrangler d1 execute --local` hangs, then "Body Timeout Error"
One `--file` much over 1 MB stalls local D1 (miniflare) and throws
`HashIndex detected hash table inconsistency`. Apply through
`node seeds/apply.mjs` (what `npm run db:*` calls), which applies the street
geometry in ≤700 KB chunks.

### Overpass 429 during a seed sweep
The public mirrors rate-limit. Use the self-hosted instance
([tools/osm-seed-builder/README.md](../tools/osm-seed-builder/README.md)).

## Measuring

### Timings from inside workerd read 0.000 ms
The clock steps in 1 ms increments and stops advancing about 97 ms into a
synchronous stretch. Measure in Node instead
([runbook.md](runbook.md#measure-a-cpu-burst)).
