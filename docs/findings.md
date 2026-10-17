# Findings

Facts measured about the outside world: OpenStreetMap, Nominatim, the source
websites, and the Cloudflare runtime. Each entry says when it was measured
and how, so it can be re-checked rather than trusted. The code's behaviour is
in the [specification](specification.md). The decisions these facts led to are in
[design-decisions.md](design-decisions.md).

The **Dead ends** section near the end lists what looked like a fix and was
not. Check it before retrying something.

---

## OpenStreetMap and Overpass

### `admin_level 8` in Bulgaria is a single settlement
Measured 10.08.2026 against the local Overpass instance: `rel(13477567)`
("Варна", level 8) contains exactly one `place` settlement, the city. The
repo used to hold two contradictory records of this. The seed tool's claim
that level 8 is the община was the wrong one. Level-8 names still repeat
across provinces (there are two level-8 `Бяла`), so a query pinned to level 8
also needs a province or distance bound.

### Settlement names repeat all over Bulgaria
In Bulgaria there are two Бяла, two Левски, two Дебелец, two Войводино, two
Ботево, two Искър and **four** Горица. A per-settlement query that resolved
by name unioned all of them. 420 of 2,974 seeded streets (14%) came from a
same-named town elsewhere, Бяла's from Бяла in Русе, 185 km away. Fixed by
keying each query on the boundary relation's **element id**.
[accuracy.md §1.0](accuracy.md#10-the-root-cause-the-per-settlement-query-was-not-bounded-to-the-province).

### Two places can share a name 10 km apart within one province
Варна province has two Припек: a village (`node/273877517`, 43.2547 27.7381)
and a suburb of Константиново (`node/9581652747`, 43.1743 27.7958). A village
Чайка also lies 50 km from the resort suburb Чайка. **A name test alone cannot
tell "one place tagged twice" from "two places sharing a name"**, so every
name-keyed rule in the seed sweep carries a distance check.

### Most villages have no boundary relation
Тополи, for example, is a bare `place=village` node. Queries fall back to
`around:<radius>` from the centre point.

### Districts are points, not areas
68 of Варна province's 80 districts are a single node with no extent. The 12
that have an extent are all `м-т`/`с.о.` villa zones. Every district an alert
would name (Виница, Аспарухово, Галата, Чайка) is a bare point, so streets
cannot be tied to districts from OSM.

### One street, two OSM spellings
`бул. Януш Хуняди` is a single 118 m way inside Варна. The rest of the
boulevard is `бул. Янош Хунияди`. Their cores score 0.389, below
`Младост 1`/`Младост 2` (0.667) and `Възраждане 1`/`2` (0.733), so the two
spellings cannot be merged by similarity. When a polygon fails with "the
streets enclose no block" even though every name resolved, count the ways per
name. A single short fragment is the signature, so look at what continues it
at each end.

### OSM's street names are inconsistent across settlements
Most are bare (`Никола Вапцаров`), 47 carry a spaced kind (`бул. Княз Борис
I`), and one carries a glued kind (`ул.Никола Вапцаров`, in Горица). Each is
the real `name` tag and must be stored as is.

### `м-т` places are tagged `locality`
They had to be added to the seed's `DISTRICT_PLACES` (about 90 rows) and to
the reverse-geocode levels. Without the second, alerts could name these places
but no user could ever be registered in one.

### Overpass behaviour
- `overpass-api.de` answers a **browser User-Agent with 406**. Send a
  descriptive one.
- `kumi.systems` timed out from both a local IP and the edge (19.07.2026).
- The public endpoints rate-limit after a few queries during a seed sweep.
  Use the self-hosted instance (`tools/osm-seed-builder/overpass`).
- Six of the eight polygon failures in the August review were HTTP 521/504,
  meaning the public endpoint was down. The builder is deterministic: the
  same four streets failed on 18.08 and built a byte-identical ring on 20.08.
  The builder's real success rate is about 80%, against an observed 50%.
- The self-hosted instance binds to `127.0.0.1`, which a Worker on the edge
  cannot reach. Using it from production would need a Cloudflare Tunnel.

## Nominatim

- OSM tags a bus shelter with the same name as the area around it, and
  Nominatim can rank the shelter first. An outage across five Provadia
  villages was once pinned on a shelter in Varna. Non-place classes are
  skipped.
- Reverse geocoding labels one point at several levels (`suburb`,
  `neighbourhood`, `locality`, `quarter`, `city_district`, `city`, …), and
  only some of them exist in our tables. Returning one name meant central
  Varna matched nothing.
- Usage policy: at most 1 request per second, a descriptive User-Agent, and
  caching. The client keeps calls at least 1,100 ms apart with a promise
  chain, because a timestamp check let two concurrent callers fire together.

### Places that do not exist in OSM or Nominatim
Checked 31.08.2026, so do not retry. These twelve `м-т` names fall back to
the Варна centroid:

> Ваялар, Малко Ю, Екшелма, Голяма могила, Роз Марин, Кара Али, Караулница,
> Баба Алино, Салтанат, Коджа тепе, Руските окопи, Пътека тала

- Overpass, over a Varna-wide bbox (43.05–43.40, 27.65–28.10), every element
  type: one hit, `Коджатепе`, a `natural=peak`. That is a summit, not a
  locality.
- Nominatim, with the Worker's query shape (`<name>, Варна, България`,
  `countrycodes=bg`), with and without `м-т`: zero results for all twelve.
- In OSM, `Фатрико дере` is a stream. `Траката` is mapped as three
  neighbourhoods (Горна, Средна and Долна Трака) and is served by an alias
  onto Средна Трака.
- `м-т "Малко Ю"` is ViK's own wording, not a truncation: it appears six
  times in the corpus.

Recovering these needs another source: the cadastre, or adding them to OSM.
That is a data-gathering task, not a code change.

## The sources

- **vikvarna answers every id with 200.** An empty id renders the listing
  shell, so "nothing here" has to be detected by parsing, not from the status
  code. The probe stops after 3 consecutive misses and never counts a fetch
  error as a miss.
- **erpsever.bg changed its API without notice.** A call with no parameters
  returns the area list with every bucket empty. Entries come back only for a
  queried `region_id` + `type`.
- **The sources hedge consistently.** "ще бъде прекъснато" is a confirmed
  outage and "възможни са смущения" a possible one. In the 08.2026 corpus,
  92 alerts were hedged. ViK 17375's "ще бъдат със смущения … както и липса
  на вода" is **confirmed**, so matching on "смущения" alone is wrong.
- **Duplicate pairs**: in the 08.2026 corpus, 9 groups (18 alerts, 3.8%) were
  a confirmed outage paired with a hedged message for the same area and hours.
- **Page sizes creep.** heating's listing reached 51 KB and crossed the CPU
  cap around 13.08.2026. The scrape tests now set a byte budget on what each
  parser receives.
- **Every source can be fetched from Cloudflare's edge** (Phase 0, 19.07.2026):
  responses were byte-identical to a local IP's.

## Cloudflare runtime

### The 10 ms CPU limit caps one burst
Ticks complete with `outcome: ok` at 53 and 94 ms of `cpuTime`. Killed ticks
report exactly 10. A scheduled invocation gets minutes of wall clock.
Measured 30.07 and 31.08.2026.

### Cold-isolate costs dominate, and every cron tick is cold
- The first `matchRegion` call cost 6.78 ms and the first `matchStreet`
  4.85 ms, and 252 regions cost **more** than 1,333 streets. The dominant cost
  was JIT warm-up, not per-row work. Moving the work to startup: 0.37 and
  0.79 ms.
- The first JSTS `BufferOp` cost 9 ms; the next one cost 3 ms.
- `cheerio.load()` cold, in Node v24, on full-size pages: 7.8–14.4 ms per call.
  Three of five call sites were over the cap in a runtime **faster** than
  workerd.
- Startup time was 27 ms of the 400 ms budget at the last reading. The seed
  has grown since, so read it off the next deploy.

### HTMLRewriter has two silent traits
- A `text` handler fires for text **anywhere** inside the matched element.
  Also registering `sel *` counts every nested node twice.
- It does **not** decode character references, so `&quot;` and `&#1073;`
  arrive verbatim.

### workerd's clock cannot time a burst
`performance.now()`/`Date.now()` step in 1 ms increments, then **stop
advancing about 97 ms into a synchronous stretch**. Burn loops read 2, 20 and
75 ms, then everything after reads 0.000. Yielding makes it worse. Measure in
Node instead (see [runbook.md](runbook.md#measure-a-cpu-burst)).

### Other platform facts
- The Cloudflare schedules API can report a cron that is not the one firing.
- An `exceededCpu` kill discards the invocation's `logs` and `exceptions`.
- Workers AI does not work on throwaway preview accounts.
- `PRAGMA foreign_keys` cannot be set on D1, and `defer_foreign_keys` does not
  help a table rebuild. Migrations 0015 and 0017 park child rows instead.
- `wrangler deploy` reports "non-interactive environment" when the stored
  OAuth token has expired.

## Workers AI

- `llama-3.1-8b-instruct-fp8` rejects JSON schemas (error 5025).
  `llama-3.3-70b-instruct-fp8-fast` fails on `"type":["string","null"]` (5024).
- qwen3-30b at the default 2,000 tokens spends the whole budget reasoning and
  returns no JSON.
- In about one run in five, qwen3 emits a single location `град Варна`
  instead of `city_wide: true`. Guard A3 handles it.
- Latency: 4–21 s per call in July. From 30.07 it often exceeds 30 s (6
  timeouts against 8 ingested messages over three ticks). Whether that is
  the new normal is unmeasured; see [open-questions.md](open-questions.md).

---

## Dead ends

Each looked like a fix and was not.

| Tried or proposed | Why it does not work |
|---|---|
| Seed the twelve missing `м-т` names | Neither OSM nor Nominatim has them (above) |
| Space out glued prefixes in the seed (`ул.Никола` → `ул. Никола`) | The stored string is the Overpass key, so the edit would match zero ways. `parseName` already handles the glued form |
| `DELETE FROM geocode_cache` after a rule change | Cached answers pass through the same checks. Nominatim would return the identical row, at the cost of a throttle slot |
| Learn OSM spelling variants by similarity | The variants score lower than genuinely different places |
| Make cheerio cheaper by slicing its input, or warming it | The cold cost is a fixed floor |
| An in-memory trigram index to cut matcher CPU | It would still be built per isolate. The startup-time fix already solved the problem |
| Workers Paid to survive a CPU kill | More total CPU does not raise the burst ceiling |
| Raise the AI timeout | It starves the other sources within the tick deadline |
| Time bursts with `performance.now()` inside workerd | The clock stops advancing (above) |
| Shorten the polygon extension to 25 m | That measurement predated the clip-window fix. 25 m destroyed three real blocks |
| "Unlink Припек from Константиново" | That link was correct. The village row had been deleted. See [incidents.md](incidents.md) |
| Re-optimise the matcher when ingest dies at `exceededCpu` | Since 30.07, the culprit has been a different burst each time. Measure first |
