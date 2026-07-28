# Fix plan — review of 28.07.2026

Derived from `review-20260728-102959.md` (99 alerts: 54 accurate, 33 inaccurate, 12 not
implemented). Every finding below was reproduced locally against the real seed tables and
the AI output actually stored in D1, so each item names a cause rather than a symptom.

Two things the review did not see, both worse than what it reported:

- **The 5 "empty location json" alerts were broadcast to every user.** `applyCityWideGuard`
  ([pipeline.ts:108](../../../backend/src/ingestion/pipeline.ts#L108)) turns a lone `"Варна"`
  location into `city_wide = true`, and `sendUsersNotification` answers `city_wide` with
  `getAllUserIds` ([alert-service.ts:210](../../../backend/src/core/alert-service.ts#L210)).
  The guard was written for a model that says "Варна" when it means the whole city; it also
  fires when the model simply *loses* the district, converting an extraction failure into the
  widest action the pipeline can take.
- **The name-ambiguity alerts reached nobody, not just the wrong pin.** Users get their
  `region_id` from Nominatim's fully-prefixed OSM name — verified: a user standing in
  кв. Аспарухово is assigned `кв. Аспарухово`. An alert whose name resolves to the *village*
  `Аспарухово` targets a disjoint region id, so `getUserIdsByRegion` returns zero rows. The
  district got no notification at all.

## Evidence

Reproduced with the real `fuzzy.ts` over `seeds/regions.json`, replaying the stored parses:

| Alert | Source text | Today | Cause |
|---|---|---|---|
| `27057824` ★ | `кв."Аспарухово"` | pin 42.979, 27.321 (village, 55 km away) | model dropped `кв.`; bare `Аспарухово` scores **1.000** on the village vs **0.786** on `кв. Аспарухово` |
| `fc2f2837` ★ | `…с. Баново, м-т и прилежащите…` | pin = `м-т Фичоза` | bare `м-т` scores **0.364**, over the 0.3 threshold |
| `c921a48e` ★ | `…с. Баново, местност и прилежащите…` | pin 43.111, 27.924 | no region match → Nominatim returned `Защитена местност Ракитник` (exact match to the stored coords) |
| `83469534` ★ | `в карето между бул. Владислав, ул. Беласица, …` | `is_polygon=false`, pin = centroid of бул. Владислав Варненчик | model ignored the polygon rule; pin falls back to the first street |
| `0f8c45b5` | `Св.св.Константин и Елена` | pin = `Константиново` | **0.385** false positive. Nominatim resolves the name correctly (43.233, 28.011) — the bad fuzzy match prevented the right answer |
| `584f1445` | `ж.к. Чайка` | pin = resort `Чайка` (43.255, 28.028) | bare `Чайка` **1.000** on the resort vs **0.667** on `кв. Чайка` |
| `2f891a6b` +2 | `ж.к. Младост` | pin 43.192, 27.713 (Девня) | `ж.к. Младост` **0.667** vs `ж.к. Младост 1` **0.571** |
| `406268df` +8 | `гр. Варна - кв. Младост` | `{name:"Варна", sublocations:["Младост"]}` | epro's `гр. X - кв. Y` shape has no slot in the flat `(location_name, sublocations)` schema; the district lands in the street array |
| `02a87cbf` +4 | `гр. Варна - кв. Владислав Варненчик` | `locations_json = []` | district dropped → city-wide guard → **broadcast** |
| `d1bb87b1` +2 | `ул. Пловдив 25` | house number kept | never stripped |
| `8360abda` | `Вилна зона` | pin = a bus stop | not in seeds; Nominatim returned `Вилна зона /Виница/ [bus_stop]` |
| `6151b0bc` +12 | `От 30.07 до 31.07 В периода 8:30 до 17:00` | 30.07T08:30 → 31.07T17:00 | the prompt explicitly instructs this ([constants.ts:63](../../../backend/src/shared/constants.ts#L63)); it means 08:30–17:00 *each day* |

The 4 **Duplicate** alerts all have `source_ref IS NULL` — manual `/submit-data` injections,
which skip dedup by design. Not a crawler defect; nothing to fix there.

## Phase A — deterministic pipeline guards

No schema change, no app change, no dependence on what the model happens to emit. New pure
module `backend/src/ingestion/normalize.ts`, called from `processOutageMessage` between the
AI parse and polygon building. Unit-testable without D1.

**A1 · Drop placeless locations.** A name that is only a kind abbreviation (`м-т`, `местност`,
`м-ст`, `кв.`), a generic noun (`карето`, `зона`, `квартал`), or an explicitly non-place kind
(`м-н …` = магазин, `фирма … ООД`, `ТП 726`) is not a location. Drop it before enrichment.
Fixes `c921a48e` ★, `fc2f2837` ★, and the `м-н Бурлекс` pins (3 alerts).
*Verified:* the prototype returns `null` for `м-т` where today's matcher returns `м-т Фичоза`.

**A2 · Force `is_polygon` from the source text.** When the message contains a polygon cue
(`карето`, `затворени`, `между`) and the location carries ≥3 sublocations, set
`is_polygon = true` regardless of what the model said. Fixes `83469534` ★.
*Verified:* Overpass + `buildBlockPolygon` on that street set produces a 124-vertex polygon
centred at 43.201942, 27.899912 — 1.4 km from today's wrong pin.

**A3 · Narrow `applyCityWideGuard`.** Require an explicit city-wide phrase in the message
(`всички абонати`, `цялият град`, …) before rewriting a lone `"Варна"` into a broadcast.
Absent that phrase, keep the location and let it target region-wide Варна. This is the safety
net for the 5 broadcast alerts; **E1** is what actually recovers the district.

**A4 · Promote region-like sublocations.** A sublocation carrying a region kind (`кв.`,
`ж.к.`, `м-т`, `с.`, `к.к.`) or ending in `зона` is its own location, not a street — lift it
out of the array into a location of its own, keeping the city as context only. Needs the
regions/streets rows to catch the unprefixed cases (`Младост`, `Владислав Варненчик`); pass
them in as arguments so the function stays testable. Fixes the 9 subregion alerts.

**A5 · Strip trailing house/block numbers and address detail.** `ул. Пловдив 25` →
`ул. Пловдив`, `бул. Чаталджа 20 вх. Б.` → `бул. Чаталджа`, and the `бл 66 до бл 70` range.
Strip a trailing bare number (optionally one letter) plus any `вх.` / `бл.` / `ет.` suffix.
Apply **only** to names carrying an explicit `ул.`/`бул.` kind, and treat a strip that empties
the core as a no-op (the model sometimes emits `ул.7`, a truncated ordinal).
*Verified safe:* no seeded street with a `ул.`/`бул.` prefix ends in a bare number, no region
name carries a street prefix, and every numeric street name is an ordinal (`25-та`, `1-ва`),
so `ал. 1`, `ж.к. Възраждане 1` and `Зеленика 9` are untouched. Fixes 3 alerts.

## Phase B — the matcher

**B1 · Kind-aware, locality-preferring region match.** New `backend/src/core/place-names.ts`
holding `parseName(raw) → {kind, core}`, recognising every spelling the model has actually
produced (`ЖК`, `ж.к`, `м.`, `м-ст`, `ж.к "Младост"`, `ул.7`) — not just the canonical form
the prompt asks for. Then match on `core`, with:

- **kind compatibility as a filter** — `к.к. Чайка` must not match `кв. Чайка`; a kindless
  seeded row stays compatible with anything.
- **in-city preference inside a 0.2 near-tie band** — every source is Varna-scoped, and a
  like-named district carries orders of magnitude more users than a village. In-city =
  within 9 km of the seeded `Варна` centroid; no migration, `NamedRow` already has lat/lng.
- **threshold 0.40 for core comparison, not 0.30.** Stripping the prefix raises every score,
  so the old threshold starts admitting junk. Sweeping the real name set gives clean
  separation: every wanted match scores ≥ 0.417, every false positive ≤ 0.357.

*Verified* against all 102 distinct `location_name` values the pipeline has produced:
**8 fixed, 0 regressions.** `Аспарухово`→`кв. Аспарухово`, `Чайка`/`ж.к. Чайка`→`кв. Чайка`,
`Младост`/`ж.к "Младост"`→`ж.к. Младост 1`, `м-т`→none, `Св.св.Константин и Елена`→none
(then Nominatim, which gets it right), `Траката`→none. Two unspecified changes, both
improvements: `Изгрев`→`кв. Изгрев` (was a village 20 km out), `ЖК Възраждане`→`Възраждане 1`
(was `4`; arbitrary either way, now deterministic).

Keep `bestMatch` itself as-is and add `matchRegion`/`matchStreet` wrappers on top — the
polygon resolver ([polygon.ts:397](../../../backend/src/ingestion/polygon.ts#L397)) and the
reverse-geocode path ([auth.ts:82](../../../backend/src/api/auth.ts#L82)) are working today
and should not move in the same change. Memoise `parseName` per candidate array the way
`candidateGrams` already does — 245 regions × per-alert calls against a 10 ms CPU budget.

## Phase C — the time model

The largest bucket (13 + 3 alerts) and the only one needing a migration. The flat
`start_time`/`end_time` pair cannot express either shape the sources actually publish.

**C1 · `windows_json TEXT NULL` on `alerts`** (new migration `0012`):

```json
{ "from_date": "2026-07-30", "to_date": "2026-07-31",
  "daily": [{ "start": "08:30", "end": "17:00" }] }
```

Keep `start_time`/`end_time` as the derived **envelope** (first date @ first start clock →
last date @ last end clock) so the feed, the push body and the app's active-window check keep
working untouched. `windows_json` is additive and NULL for single-window and legacy rows.
This one column covers both C1 (daily recurrence, 13 alerts) and C2 (multiple windows,
3 alerts) — `daily` is an array.

**C2 · Replace `start_time`/`end_time` in the AI schema with a `schedule` object.** Asking
the model for both a schedule and a flat pair invites contradiction; derive the pair in
`normalizeSchedule()` instead. Touches
[schemas.ts:16](../../../backend/src/shared/schemas.ts#L16),
[constants.ts:58-64](../../../backend/src/shared/constants.ts#L58),
[datetime.ts](../../../backend/src/shared/datetime.ts) and every `outage` case's expected
output in `spikes/ai-eval/corpus.json`.

**C3 · `formatWindow`** renders `30.07–31.07, 08:30 – 17:00 daily` and
`30.07 09:00 – 11:00, 15:00 – 17:00`.

**C4 · Frontend** reads `windows_json` when present: active = date in range **and** clock in
one of the windows. Until it ships, the envelope keeps today's (wrong for multi-day, right
for single-day) behaviour, so the backend can land first.

## Phase D — reference data

Via `tools/osm-seed-builder`, keeping names as the key (ids are unstable — see the builder's
notes).

**D1 · Add the missing places** the sources name and the seed lacks: `к.к. Св. св. Константин
и Елена`, `Западна промишлена зона`, `Южна промишлена зона`, `Промишлена зона Метро`,
`Вилна зона` (as a district, not the bus stop), `Фазанария Провадия`. Nominatim already
resolves the first four correctly, so the coordinates are available.

**D2 · Parent rows for the numbered districts**: `ж.к. Младост` and `ж.к. Възраждане` inside
Varna, so a message naming the district generically pins the district rather than an
arbitrary sub-block. This is what makes B1's `Младост → Възраждане 1` tie-break unnecessary
rather than merely deterministic.

**D3 · Disambiguate the out-of-city collisions**: the `ж.к. Младост` row at 43.192, 27.713 is
in Девня, and the bare `Аспарухово`/`Чайка` rows are a village and a resort. Rename them to
carry their settlement (`ж.к. Младост (Девня)`) so the ambiguity stops existing in the data,
not just in the matcher.

**D4 · Alias support** — one region, several written forms (`Владислав Варненчик` →
`кв. Владиславово`, which B1 already gets right at 0.462 but only by luck of the trigrams).
A `region_aliases(alias, region_id)` table read into the same 6-hour ref cache. Lowest
priority; B1 covers the observed cases.

## Phase E — the prompt

Nondeterministic by nature, so everything here is a *second* line of defence behind Phase A,
never the only one. Every change re-validated through `spikes/ai-eval/run-eval.mjs` with a
new corpus case per rule.

**E1 · The epro `гр. X - кв. Y` shape.** Add the rule and a worked example: the district,
locality or zone after the dash is its own `location_name`; the city before it is context and
is not itself a location. This is the fix for all 14 subregion + empty-location alerts.

**E2 · A bare abbreviation is not a location.** `м-т`, `местност`, `кв.` with no name after
it must be dropped, not emitted.

**E3 · Extend the ignore list** with `м-н` (магазин), `фирма … ООД`, and `ТП <n>` — the
current instruction to "assume it's a building and do not include it" is losing to the actual
text.

**E4 · Reinforce the polygon cue** — `карето` is already in the prompt and was still missed,
so the example needs to be a `карето` message end-to-end, and `карето` itself must never be
emitted as `location_name`.

**E5 · Recover dropped locations.** `eadc7b88` lost `с. Припек` from a 5-village list.
Nothing deterministic catches this; the eval corpus needs a long-list case to measure it.

## Ordering

| | Fixes | Cost | Risk |
|---|---|---|---|
| **A** (guards) | 5 broadcasts, 9 subregion, 3 house-number, 2 ★ placeless, 1 ★ polygon | one new pure module + call site | low — additive, unit-testable |
| **B** (matcher) | 4 name-ambiguity, 2 ★ | new module + 2 call sites | low — validated at 0 regressions over the real name set |
| **C** (time) | 13 + 3 | migration + schema + prompt + eval + app | medium — the only phase touching stored shape |
| **D** (data) | overlaps A/B; removes the ambiguity at the source | seed rebuild | low |
| **E** (prompt) | the accuracy half of A3/A4 | eval re-run | medium — nondeterministic, needs measurement |

A and B are independent of each other and of everything else; do them first. Between them they
address **25 of the 45 flagged alerts** (A: 2 placeless + 1 polygon + 5 broadcast + 9 subregion
+ 2 house-number; B: 6 ambiguity) and close the unintended-broadcast path. C is the single biggest
bucket but is the only one that needs a migration and an app change, so it wants its own
branch. D is cheap and makes B's tie-breaks unnecessary rather than merely correct. E lands
last, measured by the eval harness rather than by inspection.

Re-run the review tool over freshly ingested alerts after A+B; the buckets that remain are
what C, D and E have to earn.
