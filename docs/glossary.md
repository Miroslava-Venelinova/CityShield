# Glossary

## Bulgarian place words

The sources write these words in many spellings, for example `ЖК`, `ж.к`,
`м-ст`, or `ул.7` with no space. `parseName` in `core/place-names.ts` reads
all of them, so a seeded name never needs reformatting (see
[design-decisions.md](design-decisions.md#seed-names-are-stored-exactly-as-osm-has-them)).

| Written | Means | Kind class in the matcher |
|---|---|---|
| `гр.` (град) | town or city | settlement |
| `с.` (село) | village | settlement |
| `кв.` (квартал) | quarter or district of a settlement | inside a settlement |
| `ж.к.` (жилищен комплекс) | housing estate (Младост, Чайка) | inside a settlement |
| `м-т`, `м-ст`, `м.` (местност) | named locality: villa areas, the northern coastal strip | inside a settlement |
| `с.о.` (селищно образувание) | villa zone | inside a settlement |
| `к.к.` (курортен комплекс) | resort complex | **its own class**: the sources never confuse it with the others |
| `ул.` (улица), `бул.` (булевард) | street, boulevard | street |
| `каре` / `карето` | city block bounded by named streets | polygon cue |
| община | municipality: a settlement plus its villages | not used for matching |
| населено място | a single settlement. In Bulgarian OSM data this is **`admin_level 8`** (measured) | |
| област | province (Варна province) | |

Phrases the guards read:

| Phrase | Meaning | Used by |
|---|---|---|
| `всички абонати`, `цялата Варна` | all subscribers / the whole of Varna | A3/A8: the only evidence for `city_wide` |
| `възможни са смущения` | disruptions are possible | marks a hedged alert: `info` severity, and duplicate suppression |
| `ще бъде прекъснато` | will be interrupted | marks a confirmed outage |
| `в района на`, `в близост до` | in the area of / near | A6: `region_wide` |
| `улиците:` | the streets: (an explicit list) | A13 |
| `водоноска` | water tanker | A14: streets after it locate the remedy, not the outage |

## The sources

| Category | Source | Crawl shape |
|---|---|---|
| `vik` | ViK Varna (water) | id-probe: walks `<id>.html` forward |
| `epro` | ERP Sever / Energo-Pro (power) | seen-ids over a JSON XHR |
| `heating` | Veolia Energy Varna | id-listing |
| `vt` | VarnaTraffic (public transport) | seen-ids. Produces bus lines, not places |

## Location model

| Term | Meaning |
|---|---|
| **settlement / area / streets** | The three slots of a parsed location (`shared/schemas.ts`). Each can be empty independently. One entry is one audience and one pin |
| **region** | A row in `regions`: a settlement, a district, or a locality. A row with `settlement_id` is a district; a row without one is a settlement |
| **seed** | `backend/seeds/*.json`: the regions, streets and aliases built from OSM by `tools/osm-seed-builder` |
| **alias** | A row in `region_aliases`: another written form of an existing region (`Владислав Варненчик` → `кв. Владиславово`) |
| **OSM name variant** | One street carrying two OSM spellings. Curated in `polygon.ts` (`OSM_NAME_VARIANTS`) |
| **`coords_source`** | Where a pin came from: `seed`, `nominatim`, `photon` (the geocoding fallback while Nominatim was down), `settlement` (a fallback to the settlement centre) or `none` |
| **`polygon_failed`** | Set in `locations_json` when a polygon was asked for and not built |

## Targeting and delivery

| Term | Meaning |
|---|---|
| **placement** | Does the alert name and pin the right place? |
| **reach** | Given the right place, does the push reach the right users? Reach failures are invisible, which is why audiences are logged |
| **`city_wide`** | Parser flag: everyone within 15 km of the Варна centroid. Only phrases in the message can make it true |
| **`region_wide`** | Set by A6: target the area, not just the named streets |
| **hedged** | A "possible disruption" message. The only kind ever suppressed as a duplicate |
| **"notified NOBODY"** | The log line for an empty audience. Grep the tail for it |
| **`receives_all_alerts`** | Debug accounts that get every push |
| **external_id** | OneSignal's alias for our `user_id`. OneSignal sees ids only, never locations |

## Ingestion and the platform

| Term | Meaning |
|---|---|
| **tick** | One run of the `*/15` ingest cron |
| **burst** | One uninterrupted synchronous stretch between two I/O awaits. The 10 ms CPU cap bounds a **burst**, not the tick |
| **cold isolate** | A fresh Worker instance. A 15-minute cron gets one nearly every time, so first-call costs land on every tick |
| **startup budget** | 400 ms for module evaluation, charged separately from the tick |
| **cursor** | `crawl_state.last_id` (or the seen-id set): how far a source has been ingested |
| **pinned cursor** | A cursor that cannot advance because the oldest message keeps failing |
| **`exceededCpu`** | The `outcome` of an invocation killed by the cap. Its logs are discarded |
| **heartbeat** | `ingest_health.started_at` / `completed_at`. A start with no completion means the tick was killed |
| **`DEADLINE_MS`** | 5-minute wall-clock budget per tick |
| **neurons** | Workers AI's billing unit. 10,000 a day free, reset at 00:00 UTC |

## Labels used across the docs

| Label | Where it is defined |
|---|---|
| **A1–A15** | The deterministic parse guards in `ingestion/normalize.ts`; table in [specification §1.7](specification.md#17-ingestion-ingestion) |
| **F1–F21** | Fixes from the August accuracy pass; status table at the top of [accuracy.md](accuracy.md) |
| **★** | An alert the reviewer marked important in an `alert-review` run |
| **8-hex ids** (`40b78a66`) | The first 8 characters of an alert id. Tests and docs cite the alert a rule came from |
| **§x.y** | A [specification](specification.md) section, unless another file is named |
| **Phase 0** | The July 2026 de-risking spikes |
