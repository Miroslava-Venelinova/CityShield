# Notification accuracy — failures and fixes

**Date:** 09.08.2026 · **Branch:** `cloudflare-migration` · **Baseline:** the
02.08.2026 13:00 UTC deploy (`2f478c8`, Worker version
`0752e410-777d-4377-8994-f84dfc3991ea`), which is when `alerts` was cleared and
the evaluation window opened. `crawl_state` was deliberately not reset, so the
window starts with the next crawl rather than by replaying history.

The 08.08.2026 review (`tools/alert-review/reports/review-20260808-213515.md`)
was the first measurement over fresh ingestion since that deploy. **131 alerts,
110 accurate, 16 inaccurate, 5 not implemented — 13% inaccurate**, against 33 of
99 (33%) on 28.07. The guards work. What remained was a different and mostly
*narrower* set of problems than the survey this file used to hold, and several of
them turned out to be **reference-data faults, not code faults**.

**This edition records what was found and what was done about it.** Part I is the
diagnosis, each section carrying its status. Part II is the fix log. Everything
asserted here was reproduced against the remote D1, the checked-in seed data, or
the live matcher; where a claim is an inference rather than a reproduction it
says so.

## Status at a glance

| | Fix | State |
|---|---|---|
| F1 | Log the empty audience | **shipped** |
| F2 | Stop erasing that a polygon was attempted | **shipped** |
| F3 | Bound the per-settlement sweep to its province | **shipped and re-swept** — 10.08.2026, zero backstop hits |
| F4 | Street-name normalisation | **shipped as a check** — the edit it asked for was wrong, see §1.3 |
| F5 | Seed the missing localities | **shipped, partial** — +90 rows, but 10 of the 11 are absent from OSM |
| F6 | Scope polygon street resolution, thread the settlement to Overpass | **shipped, verified live** |
| F7 | Split multi-block messages (A12) | **shipped, verified live** |
| F8 | Merge the sub-settlement kind classes | **shipped** (minus `к.к.`, see §2.3) |
| F9 | Sanity-check geocoded points | **shipped** |
| F10 | Grow `region_aliases` | **shipped, partial** — Траката added; Бяла's still impossible |
| F11 | A10 — drop names the source does not contain | **shipped** |
| F12 | Heating messages are Варна | **shipped** |
| F13 | Honour the `улиците:` marker (A13) | **shipped** |
| F14 | A11 — merge duplicate locations | **shipped** |
| F15 | Negative cues for landmark streets (A14) | **shipped** |
| F16 | Run the AI eval | **blocked** — no Workers AI credentials in dev |
| F17 | Fix the settlement-wide fallback | **shipped**, then narrowed by F19 |
| F18 | Give polygons a fallback and a tolerance | **shipped** |
| F19 | Settlement-wide vs. drop | **decided 10.08.2026 and shipped** — see §5.1 |
| F20 | Measure the AI timeout rate | **blocked** — needs a week of logs |
| F21 | Stall alarm on `crawl_state.updated_at` | **shipped** |

**§5.1 is decided: a failed extraction notifies nobody.** That ruling is what
separates F17 from F19 and it changed the answer to both — see §3.1 and §5.1.

**Three of the four ★ polygon alerts were replayed end to end** against the local
Overpass instance on 10.08.2026 and now produce rings; the fourth's key street
resolves correctly. §2.1 has the measurements.

Two failure modes are conflated in casual talk about "accuracy", and they have
different fixes, so they are separated throughout:

- **Placement** — does the alert name and pin the right place? (seed data,
  matcher, AI parse, polygon geometry)
- **Reach** — given a correct placement, does the push arrive at the right set of
  users? (targeting queries, user region/street assignment)

Reach failures are the dangerous ones, because they are invisible. A wrong pin
shows on a map; an alert that reached nobody looks identical to one that reached
everyone it should have. **That asymmetry is what F1 closes**, and it is the
reason the diagnostics went first.

**A measurement caveat that shapes this whole document.** The remote `users`
table holds 5 rows, all test accounts, most with `receives_all_alerts`. Recipient
*counts* are therefore meaningless and no number in this file is one. What the
targeting simulator (`tools/alert-review/targeting.py`) can still answer exactly
is *structural* reach — by what mechanism each location would be targeted — and
that is what is quoted. Over the 131 in-scope alerts, as measured before any of
the fixes below:

| How the location resolves | Locations | Share |
|---|---:|---:|
| `region` (a region matched) | 186 | 75% |
| `streets` (street ids matched inside a settlement) | 42 | 17% |
| **`none` — targets nobody, by construction** | **20** | **8%** |

All 20 are `м-т` (местност) names. F8 closes three of them outright and the
re-sweep closes one more (`Ракитника`); `Траката` is answered by an alias. The
remaining seven are not in OSM at all — see §1.4, which is where that turned out
to be a data-availability problem rather than a tool one, and §3.3.

---

# Part I — The failures

## 1. Reference data: the seed itself was wrong

This was the largest single cause behind the 08.08 review's findings. The 02.08
province seed multiplied coverage — 260 regions, 2,974 streets, 63 settlements —
and the sweep that produced it was careful in every way but one.

### 1.0 The root cause: the per-settlement query was not bounded to the province

**Status: fixed and re-swept, 10.08.2026.** 170 settlements, 168 districts and
2,413 streets against the local Overpass instance. **Zero settlements skipped and
zero hits on the 15 km backstop** — which is the evidence that matters: the
backstop exists to fire when something else has gone wrong, and after the
relation-id fix nothing did.

`tools/osm-seed-builder`'s province sweep enumerates settlements **inside** the
province area, correctly. It then issued one request per settlement, and that
request re-resolved the settlement **by name, with no province bound**:

```
relation["name"="{name}"]["boundary"="administrative"]["admin_level"="{level}"];
map_to_area->.s;
(  way(area.s)["highway"~"^({streets})$"]["name"];  … );
```

The template's own comment explained that pinning `admin_level` keeps it "off the
province-scope trap the polygon builder still has". It does — the *city* of Варна
is no longer confused with the *province* of Варна. But `admin_level=8` names a
settlement-level unit, and those names repeat all over Bulgaria. Every same-named
relation in the country matched, `map_to_area` turned **all** of them into `.s`,
and the union was what got searched.

Verified against live Overpass — each of these has multiple `admin_level=8`
relations nationwide, and the second column is the one whose streets ended up in
our seed:

| Name | Relations in BG | The province row | The one that polluted it |
|---|---:|---|---|
| Бяла | 2 | 42.878, 27.856 (Варна) | 43.438, 25.709 (Русе) |
| Левски | 2 | 43.308, 27.661 (Варна) | 43.363, 25.141 (Плевен) |
| Дебелец | 2 | 42.963, 27.446 (Варна) | 43.038, 25.587 (В. Търново) |
| Войводино | 2 | 43.409, 27.620 (Варна) | 42.196, 24.791 (Пловдив) |
| Ботево | 2 | 43.446, 27.723 (Варна) | 42.354, 26.367 (Ямбол) |
| Искър | 2 | 43.384, 27.480 (Варна) | 43.652, 24.463 (Плевен) |
| Горица | **4** | 42.920, 27.830 (Варна) | 43.653, 28.165 and two more |

Those coordinates match the stored street rows exactly. The 13 settlements that
have **no** boundary relation are unaffected, because the `around:` fallback
searches from the centre point the enumeration already resolved inside the
province — the one place the sweep did carry its scope through.

**The fix** ([app.py:187](tools/osm-seed-builder/app.py#L187)) keys each
per-settlement request on the boundary relation's **OSM element id**, taken from
the enumeration, which already resolved it inside `area.p`. Identity, not a name;
nothing can collide with it. A name resolving to more than one relation *inside*
the province is now reported and skipped rather than unioned — silent unioning is
what produced this, and the tool's own doctrine is that a rule you cannot see
applied is one you cannot notice being wrong.

### 1.1 Fifteen settlements' streets came from a same-named town elsewhere

**Status: fixed. The bad rows were pruned, then the corrected sweep replaced the
whole extraction.**

The previous edition measured this as a *median* distance per settlement, which
undercounted it: a settlement whose rows are mostly correct with a polluted tail
has a clean median. Measured per row instead — every `streets` entry against its
own settlement's centroid — **420 of 2,974 streets (14%) sat more than 15 km from
the settlement they claim**, across fifteen settlements rather than eleven:

| Settlement | Rows beyond 15 km | | Settlement | Rows beyond 15 km |
|---|---:|---|---|---:|
| Бяла | 131 | | Горица | 8 |
| Левски | 92 | | Искър | 8 |
| Дебелец | 45 | | Черковна | 8 |
| Войводино | 38 | | Езерово | 3 |
| **Варна** | **29** | | Генерал Колево | 1 |
| Ботево | 24 | | Добри дол | 1 |
| Стефан Караджа | 13 | | | |
| Орешак | 10 | | | |
| Каменар | 9 | | | |

Варна's 29 are the ones the median test could never have found — the city's own
1,333 rows have a median of 3.5 km and a 95th percentile of 10.7 km, which is
right for a city of that extent, and the pollution hides in the last 2%. Каменар's
nine come from Черноморец, 74 km south. Орешак's ten from Орешак in Ловеч, 259 km
away.

The `regions` rows were correct — Бяла's centroid is 42.877, 27.885, the
Varna-province town — but 131 of its street rows carried coordinates from Бяла in
Русе province. Бяла is not hypothetical: ViK published for it three times in this
window (`9a12ae10`, `fa675662`, `52e21c59`).

**What was done.** A wrong row is worse than a missing one, and the difference is
not academic: for a polluted settlement the rows *exist*, so `settlementScope`
resolves, the street gate opens, and targeting proceeds confidently against street
ids belonging to another town. Delete the row and the gate closes instead, the
location falls back to region-wide, and the outcome is merely coarse. So the 420
rows are gone from `seeds/streets.json` (2,974 → 2,553, which also drops one
unusable name — see §1.3), and `backend/seeds/verify.mjs` +
`backend/test/seeds.spec.ts` keep them from coming back. Only a corrected sweep
can put the **right** streets back.

Note the apply semantics: `seed.sql` is an upsert and never deletes, so the
pruned rows are gone from the repo and still present in any already-seeded D1.
Dropping them there needs a wipe-and-reseed.

### 1.2 A district pass was deleting settlements

**Status: fixed — and the original diagnosis was wrong in an instructive way.**

`regions.settlement_id` (migration 0016) says "this district is inside that
settlement". Three rows said a *village* is inside another village:

| Child | Parent it was linked to | Distance |
|---|---|---:|
| Раков дол | Орешак | 259 km |
| Гара Бяла | Бяла | 191 km |
| **Припек** | **Константиново** | **1.7 km** |

The first two were F3's unbounded name lookup reaching into another province, and
they became impossible the moment the query was keyed by relation id. Припек is a
different animal, and the previous edition got it wrong.

**What was actually happening.** Queried against the local Overpass instance on
10.08.2026, Варна province holds **two** places called Припек, 10.09 km apart:

| | OSM | Where |
|---|---|---|
| the village | `node/273877517`, `place=village` | 43.2547, 27.7381 |
| a suburb of Константиново | `node/9581652747`, `place=suburb` | 43.1743, 27.7958 |

So the suburb *belongs* under Константиново — that link was never wrong, and
"unlinking Припек" (which the previous edition did by hand) was fixing the wrong
row. What was wrong is that **the village row had been deleted**: the sweep writes
settlements first and districts second, and the district pass runs
`authoritative`, whose removal rule retires any entry whose *name* the batch
produced under a different key. `("Припек", Константиново)` therefore retired
`("Припек", no parent)`.

Since migration 0017 a settlement row and a district row of one name are two
different places **by construction** — that is precisely what putting the parent
in the key means — so a batch of districts can say nothing about the parentless
row. `merge_into_seed`'s removal pass now skips them.

With the village restored, `с. Припек` still had one more hop to make. Its second
half is in `settlementScope`, which asked the parent-link question *before* the
written-kind question, so an unscoped `matchRegion("с. Припек")` could land on the
suburb and be answered with Константиново's centroid anyway. A name that states
its own settlement kind (`гр.`/`с.`) is never a district of something else, so
that lookup now goes first. See §3.1's note on ordering.

**And the categorical rule needed a proximity half.** "A district whose name is
one of the province's settlements is not a district" catches Припек and also
refuses the resort suburb **Чайка** — because a *village* Чайка exists 50 km away
at 43.08, 27.43, and two different places sharing a name is exactly what 0017
exists to allow. The rule now fires only within `SAME_PLACE_KM` (2 km), which
separates 0 km from 50 km with four orders of magnitude to spare.

The lesson generalises past this row: **a name test alone cannot tell "one place
tagged twice" from "two places sharing a name".** Every rule in the sweep that
keys on a name now carries a distance beside it.

### 1.3 Street names carry inconsistent kind prefixes — and that was never the bug

**Status: the plan's proposed edit was wrong and was NOT made. A check ships
instead.**

Most rows are bare (`Никола Вапцаров`, `Чаталджа`); 47 carry the kind spaced
(`бул. Княз Борис I`) and exactly one carries it glued (`ул.Никола Вапцаров`).
The seed took whatever OSM `name` held, and OSM is inconsistent across
settlements.

The previous edition proposed inserting the missing space, on the stated grounds
that "a row whose kind cannot be parsed is a row whose core is wrong". **That
premise is false.** `parseName`'s pattern for `ул.` is `/^(?:улица(?![\p{L}])|ул\s*\.|ул(?=\s))\s*/iu`
— the `\s*` after the dot is optional — so the glued form parses correctly:

```
"ул.Никола Вапцаров"  → { kind: "ул.", core: "Никола Вапцаров" }
"ул. Никола Вапцаров" → { kind: "ул.", core: "Никола Вапцаров" }
```

The prefix never corrupted the core. What it did was win a **literal whole-name**
comparison, which is what `bestMatch` does and what the polygon path was still
using: `ул. Никола Вапцаров` scores 0.80 against `ул.Никола Вапцаров` and 0.58
against the bare `Никола Вапцаров`. That is a defect of the *comparison*, and F6
removes it by switching the polygon path to `matchStreet`, which compares cores.

Making the proposed edit would have been actively harmful: the stored name is
what F6 sends to Overpass, and Варна's way genuinely is named `Никола Вапцаров`
there. Rewriting it to `ул. Никола Вапцаров` would match zero ways.

What did ship is the verification half — `test/seeds.spec.ts` asserts that every
seeded name parses to a non-empty core. It immediately found one that does not:
a street in Девня literally named **`Площад`**, which is the spelled-out kind
with nothing after it. Its core is the empty string, so it could never match
anything and nothing could ever match it. Removed, and the sweep now drops such
names at extraction.

### 1.4 Varna's localities are not seeded

**Status: partially fixed, and the acceptance list turned out to be
unsatisfiable from OSM.**

Eleven distinct `м-т` names appeared in the window with **no `regions` row at
all**: Ваялар, Траката, Ракитника, Голяма могила, Коджа тепе, Руските окопи,
Фатрико дере, Емешенлията, Малко Ю, Глико, Пътека тала. epro and ViK both publish
against them routinely — they are how outages in the northern coastal strip are
addressed.

The cause was believed to be one token: the sweep's `DISTRICT_PLACES` was
`suburb|neighbourhood|quarter|borough`, and OSM tags a местност as `locality`. It
is now `suburb|neighbourhood|quarter|borough|locality`, which is a real fix — the
re-sweep gained **~90 district rows**, and `м-т Ракитника` resolves because of it.

**But it does not satisfy the acceptance list, because OSM does not hold those
places.** Searched across the whole province on 10.08.2026, by exact name and then
by substring:

| Name | What OSM actually has |
|---|---|
| Ракитника | `place` row — **seeded, resolves** |
| Траката | no place of that name; the area is mapped as three neighbourhoods, `Горна`/`Средна`/`Долна Трака`, plus a hotel and a bus stop called Траката |
| Коджа тепе | `Коджатепе`, `natural=peak` (43.2330, 27.9729) — a summit, not a place |
| Фатрико дере | `waterway=stream` (43.2402, 27.9727) — a watercourse |
| Ваялар, Голяма могила, Руските окопи, Емешенлията, Малко Ю, Глико, Пътека тала | **no feature of that name at all** |

So the tool change was necessary and is not sufficient. Траката is answered by an
alias onto `Средна Трака`, the middle of the three real neighbourhoods (F10). The
remaining nine need either hand-written `regions` rows with locally-known
coordinates, or aliases onto whatever district actually contains them — and
neither can be derived from OSM, so neither was invented here.

**A second half of F5 that the plan did not anticipate.** Seeding a locality only
half-works on its own: a `regions` row lets an *alert* resolve to the place and
get a pin, but a user can only be registered under it if reverse geocoding returns
that level, and `core/geocoding.ts` asked for
`suburb, neighbourhood, quarter, city_district, city, town, village` — no
`locality`. Ninety new rows would have been ninety places alerts could name and no
user could ever be in. `locality` now sits in that list too, between
`neighbourhood` and `quarter`.

## 2. Placement failures

### 2.1 Every polygon in the window failed to build ★

**Status: fixed. Both causes are closed and three of the four ★ alerts were
replayed end to end against live Overpass on 10.08.2026.**

All four alerts the reviewer marked important are the same failure: the message
says `каре`, the deterministic A2 guard correctly sets `is_polygon`, the build
returns null, and `enrichLocations` silently cleared the flag. The stored rows
carried `is_polygon: false` and a pin on an arbitrary street, so nothing
downstream recorded that a polygon was ever attempted.

**This was the most misleading line in the pipeline, and it misled the review.**

```ts
dto.is_polygon = false; // polygon was requested but not built
```

The comment was honest and the stored row was not. Measured over the whole
window: **252 of 252 stored locations carried `is_polygon: false` with no
geometry** — a build failure and a message that never mentioned a block were
byte-identical once stored. A reviewer reading the row could only conclude the
flag was never raised, i.e. that the AI or A2 missed the `каре` cue. All four ★
notes read that way, and all four are wrong about the layer: A2 fired correctly
every time.

The review tool anticipated exactly this. It carries a dedicated badge —
`polygon flagged, no geometry` — and that badge **could never fire**, because
ingestion erased its precondition before the row was written. The one signal
built to catch this class of failure was unreachable by construction.

**F2** keeps the intent and the outcome as two separate facts: `is_polygon` is
still cleared (targeting an empty ring notifies nobody, and every downstream
reader takes the flag as a promise that geometry is present), and
`polygon_failed: true` plus a `polygon_failure` reason ride alongside inside
`locations_json` — so there is no migration, and the review tool's badge now
fires. `SELECT` on that key answers "is the polygon path working yet" without
reading a single map.

There were **two independent causes**, and three of the four alerts hit the first.

**Cause A — polygon street resolution was unscoped and literal.** Fixed by F6.
`buildPolygonForStreets` resolved names with
`bestMatch(raw, streets, (s) => s.name, POLYGON_RESOLVE_THRESHOLD)` — the whole
*written* name against the whole *stored* name, over the entire
nationwide-polluted table, with no settlement scope. It was the only street lookup
in the codebase that did not scope; `matchStreet` has taken a `scopeRegionId`
since 31.07 precisely because names repeat. The resolved name was then handed to
an Overpass query hard-scoped to Варна, so a row from another settlement produced
a name matching **zero ways**.

Reproduced against the live matcher and the remote tables:

| Alert | Written | Resolved to | Settlement of that row |
|---|---|---|---|
| `9e9d7a9e` | ул. Никола Вапцаров | `ул.Никола Вапцаров` | **Горица** |
| `d29913c5` | ул. Райко Даскалов | `Райко Даскалов` | **Провадия** |
| `d29913c5` | ул. Тодор Влайков | `Тодор Влайков` | **Дългопол** |
| `d29913c5` | ул. Панайот Хитов | `Панайот Хитов` | **Левски** |
| `d29913c5` | ул. Звзда | *no match* | — (source typo for Звезда) |
| `15af34ef` | ул. Железни врата | `Железни врата` | **Старо Оряхово** |
| `15af34ef` | ул. Подвис | `Подвис` | **Каменар** |

Confirmed end to end against Overpass: inside the Варна area, `ул.Никола
Вапцаров` returns **0 ways** while the bare `Никола Вапцаров` returns 11. So
`9e9d7a9e` had three sides of a four-sided block and could not close a ring.
`d29913c5` had three of seven; `15af34ef` two of four.

Note that §1.1's pollution and §1.3's prefixes are what made this fire. The same
code was harmless when `streets` held only Varna.

**Cause B — geometry, on a correctly resolved set.** Now reproduced and fixed.
`5d34f795` resolved all four boulevards to genuine Варна rows that all exist in
OSM — except `бул. Ян Хуняди`, which resolved to `бул. Януш Хуняди`. Measured
against the local Overpass instance on 10.08.2026:

| Street | ways in Варна |
|---|---:|
| бул. Сливница | 84 |
| бул. Република | 55 |
| бул. Владислав Варненчик | 55 |
| **бул. Януш Хуняди** | **1**, a single `highway=primary` fragment 118 m long |

One 118 m fragment is not a side of a block. Asking what continues it settles the
question the previous edition could only guess at: the ways adjoining both of its
endpoints carry the name **`бул. Янош Хунияди`** — a *third* transliteration of
the same boulevard, and one the seed also holds, because the sweep takes OSM at
its word. The boulevard is not fragmented; its name is.

The fix is a small curated map of OSM spelling variants, applied to the Overpass
fetch only: the variant's ways are folded under the name the street resolved to,
so everything downstream still sees one street — which matters, because
`buildBlockPolygon` counts *distinct* streets to decide whether a face is a block.

**Curated rather than computed, and that is a measurement.** The obvious
generalisation is to merge any two seeded names whose cores are similar enough.
There is no such threshold:

| pair | core similarity |
|---|---:|
| `Януш Хуняди` ~ `Янош Хунияди` | **0.389** |
| `Младост 1` ~ `Младост 2` | 0.667 |
| `Възраждане 1` ~ `Възраждане 2` | 0.733 |

Any rule loose enough to merge the two transliterations merges two genuinely
different numbered places first. So the mapping is written down, with one entry.

**Verified end to end.** Replayed through the real builder against live Overpass,
`бул. Януш Хуняди` goes from 1 way to 16 and the block closes: a 112-point ring
bounded by all four boulevards. `d29913c5` builds both of its blocks (§2.2) — and
its source typo `ул. Звзда`, which used to match nothing at all, now resolves to
`Звезда`, because `matchStreet` compares cores inside the settlement instead of
whole names across the country.

**The Overpass scope bug underneath both is also fixed**, and the contradiction
the previous edition had to work around is now settled:

```
area["name"="Варна"]["boundary"="administrative"]->.a;
```

Nothing pinned `admin_level`, so this unioned every administrative area named
Варна, including the province. Measured on the 30.07 review, the geometry returned
for a single street name spanned `Железни врата` 11 × 26 km, `Русе` 15 × 23 km,
`Преслав` 38 × 10 km.

**What `admin_level=8` means in Bulgaria: населено място.** `rel(13477567)` is the
level-8 relation named "Варна" and it contains exactly **one** `place` settlement
— the city. The seed tool's assertion that level 8 is the община (and that the
relation swallows Кичево and Осеново) was simply wrong, and that comment is now
corrected rather than worked around.

The level is therefore pinned, which removes the province outright. It is still
not sufficient on its own, which is why the distance filter stays: level-8 names
repeat across provinces exactly as §1.0 found — there are two `Бяла` — so a pinned
query still unions a town 185 km away, and most villages have no boundary relation
at any level and need the `around:12000` fallback regardless. `CLIP_MARGIN_M`
remains what it was, a bbox around the shortest street, but it is no longer a
band-aid over a province-wide input.

### 2.2 Two blocks in one message collapsed into one

**Status: fixed (F7, guard A12).**

`d29913c5` reads: *"карето, заключено между бул. Левски, ул. Девня, ул. Райко
Даскалов, ул. Звзда и ул. Доктор Иван Селемински **и** карето, заключено между
ул. Девня, ул. Тодор Влайков и ул. Панайот Хитов"* — two blocks sharing ул. Девня.

Both the prompt and A2 assumed one polygon per message. The model emitted a single
location with all seven streets, and A2 marked that one entry `is_polygon`. Even
with every name resolving correctly, seven streets forming two disjoint blocks
cannot produce one ring.

A12 counts the block cues, and where two of them have streets between them, splits
the street list by **where each street is named in the source**. `d29913c5` now
produces two polygon locations of 5 and 3 streets, with ул. Девня in both — that
is the shared side, and dropping it from either would leave that block open at a
corner. Gated so a message that merely repeats the word about one block is not
split, and abandoned entirely if any street cannot be located in the text.

### 2.3 Kind-class filtering rejected correct matches

**Status: fixed (F8), with one deliberate deviation.**

`kindsCompatible` treated a written kind as a hard constraint: a query classed
`locality` could never match a row classed `district`. The sources do not respect
that distinction — epro writes `м-т` for places the seed carries as `кв.` or
`с.о.`.

Reproduced:

| Written | Matched | Should match | Why it did not |
|---|---|---|---|
| `м-т Изгрев` | `Изгрев` (с. Изгрев, Суворово — 43.297, 27.695) | `кв. Изгрев` (43.234, 27.921) | `кв.` is `district`, incompatible with `locality`; the village row is bare, so compatible |
| `м-т Ален мак` | *nothing* | `с.о. Ален Мак` | `с.о.` is a villa-zone class |
| `м-т Добрева чешма` | *nothing* | `с.о. Добрева чешма` | same |

`0220dec1` is the visible case: the message is *"гр. Варна - м-ст Изгрев"* and the
pin landed on a village 25 km north-west. The reviewer's note — *"its talking
about the district in the city, not a village"* — is exactly right.

`кв.`, `ж.к.`, `м-т` and `с.о.` now share one class. **`к.к.` deliberately does
not**, which is a deviation from the fix plan and it is measured: merging it
breaks alert 584f1445's fix. With one class, `ж.к. Чайка` has both `кв. Чайка`
and `к.к. Чайка` as candidates, their cores tie at 1.000, and the last tie-break
is the literal spelling — where `к.к. Чайка` scores 0.80 against the query and
`кв. Чайка` 0.58. The resort would win every time, which is precisely the bug the
kind filter was introduced to fix. Excluding `к.к.` fixes all three rows in the
table above and keeps that. `test/place-names.spec.ts` asserts both directions,
including the risk F8 carries: `м-т Изгрев` now has the village as a live
candidate, and it is the in-city preference alone that picks the district.

### 2.4 A scoped match that fails retries unscoped, and lands in the wrong town

**Status: unchanged behaviour, now visible (F1); the case that caused it is fixed
by A13.**

`matchRegion` treats its settlement scope as a preference: if the scoped pass
finds nothing it retries unscoped. The justification stands — 171 of 260 regions
still carry no `settlement_id`, and a hard filter would make those unreachable —
but the consequence has a name.

`0d59345b`: *"гр. Вълчи дол – улиците: Васил Левски, …"*. The model filed `Васил
Левски` as the area. Scoped to Вълчи дол it matches nothing; the unscoped retry
finds **Varna's** Васил Левски, and the alert for a town 50 km away was pinned at
43.224, 27.921 — in Varna.

Two things changed. A13 stops this particular alert reaching the retry at all, by
honouring the `улиците:` marker so `Васил Левски` stays a street. And the retry
itself now warns — **but only when the answer escaped the scope**, which is the
dangerous half. The routine case (a scoped miss answered by an unlinked row) is on
a hot path and says nothing worth reading; a retry whose answer landed in *another
settlement* is rare and always worth reading. The check is a post-hoc comparison
in `getUserIdsInRange` rather than a hook inside the matcher, so it costs nothing
on the path it does not fire on.

### 2.5 Nominatim answers were accepted without a sanity check

**Status: fixed (F9).**

`803a51e4` (ViK, гр. Долни чифлик, six flower-named streets) pinned 42.987,
27.797 — 6.4 km east of the town. None of those six is seeded, so
`resolveCoordinates` fell through to Nominatim, which answered `Синчец, Долни
чифлик, България` with a point outside the town. It is in `geocode_cache` with
`resolved_at 2026-08-03T07:00:39Z`, so it will be reused.

The fix plan said to pick the threshold "by sweeping the window's geocoded points,
not by picking a round number". Sweeping the *seed* instead settles it faster and
more decisively: **no global constant can work.** Varna's own streets sit at a
median of 3.5 km from its centroid with a 95th percentile of 10.7 km — the city
really is that big — while Долни чифлик's 42 seeded streets all lie within
1.2 km. Any constant that rejects 6.4 km also rejects half of Varna.

So the threshold is the settlement's **own extent**, derived from its own seeded
streets: the 95th percentile of their distance from the centroid, plus a quarter's
margin, floored at 2 km. The percentile rather than the maximum because a maximum
is one bad row away from useless. Measured against the current seed:

| Settlement | seeded streets | p95 | limit | verdict on a 6.4 km answer |
|---|---:|---:|---:|---|
| Долни чифлик | 42 | 1.12 km | 1.41 km | **rejected** |
| Варна | 1,333 | 10.68 km | 13.35 km | accepted (correctly) |
| Провадия | 97 | 1.48 km | 1.84 km | rejected |
| Игнатиево | 54 | 0.70 km | 2.00 km (floor) | rejected |

A rejected answer falls through to the next candidate and ultimately to the
settlement centroid — a coarse pin, never a null one — and is logged.

**One refinement the plan did not anticipate.** The check only ever measures
against a settlement the *message stated*. `settlementScope` answers "Варна" for
anything it cannot place, which is the right scope to search in and the wrong
thing to judge an answer by: alert 8360abda names only "Вилна зона", whose correct
point is 40 km away in Провадия, and judging that against an assumed Варна would
reject a right answer — the exact failure this guard exists to prevent, pointed the
other way. The regression test for that alert caught it.

The poisoned `geocode_cache` rows still need purging, or the fix does nothing for
names already cached.

### 2.6 The model invents locations

**Status: fixed (F11 guard A10, and F12).**

`40b78a66` (heating) is the worst parse in the window. The entire source is:

> *"…ще бъде спряно топлоподаването за живущите в **ж.к Трошево**, блокове
> 74,79,80,81,82 и 83."*

One place. The stored parse held six locations: ж.к Трошево (correct), plus
гр. Варна with ул. Неофит Бозвели and ул. Ангел Кънчев, м-т Ваялар, м-т Свети
Никола, an unnamed entry with four boulevards, and **с. Аврен, ул. Тича** — a
village 23 km away. None of those names appear in the message.

A1–A9 all reasoned about names the model produced; not one of them asked whether
the source text contains the name. Omission has no deterministic fix (§2.9);
**invention does.**

A10 drops any slot or street whose core does not appear in the source. It is
deliberately the **weakest** form of that test — one word of the core, matched at
trigram similarity ≥ 0.6 against one word of the message — because this guard
deletes data and a false positive is a silenced alert, which is the one direction
the guard doctrine says to be paranoid about. Tightening it to "most of the words"
would also catch a model inventing a plausible neighbour of a real name, and would
delete `бул. Владислав Варненчик` from a message that wrote `бул. Вл. Варненчик`.
That trade is the wrong way round. The weak form is enough for the acceptance
case: none of the six invented locations shares a single word with the message
they were attached to.

It runs after A5 (which strips the house numbers the message *does* contain) and
after A1, and before A4's promotion — a promoted district has to be checked as the
street it arrived as. Every drop is logged by name.

The reviewer's second point is also right and is cheaper still: heating is a
district-heating network, so a Веолия message is Varna by construction. F12 is a
category constant, not a heuristic, and it lands after A10 so it restores a
settlement the message implies rather than preserving one the model invented.

### 2.7 The model drops the settlement, and a same-named Varna district takes over

**Status: partially addressed. The underlying fix is the re-seed.**

Two ViK alerts for гр. Бяла:

- `fa675662` — *"абонатите на гр. Бяла - 'Гръцката махала'"* → one location,
  settlement `null`, area `Гръцката махала`. That name matches a **Varna**
  district (id 923, `settlement_id` → Варна, 43.203, 27.919). The outage is 60 km
  away.
- `9a12ae10` — same message shape; the model kept `гр.Бяла` on `м-т Глико` and
  dropped it from `Гръцката махала` **in the same parse**.

The written form is `гр.Бяла`, with no space. `parseName` handles that, so the
loss is the model's, not the parser's.

`52e21c59` is the same failure plus §2.8: *"абонатите на гр. Бяла - 'Цветен
квартал'"* became **three identical** `кв. Цветен` entries with no settlement, all
pinned on Varna's Цветен квартал. A11 now merges those three into one, which
removes two wrong pins and two redundant enrichments but not the wrongness of the
third.

A real fix needs Бяла's own districts in `regions`, which is what the re-sweep
produces and what F10's alias row was waiting for. Until then the model dropping
a stated settlement remains a prompt-level problem.

### 2.8 Duplicate location entries were never merged

**Status: fixed (F14, guard A11).**

- `52e21c59` — `кв. Цветен` three times, byte-identical.
- `afb764bf` — `с. Припек` and `гр. Игнатиево` each twice, the second copy of
  Игнатиево carrying a 16-street list with its own typos (`ул. лозница`,
  `ул. Цанко Церковсски`).
- `c12154c9` — four separate `гр. Варна` entries carrying one street each, which
  the reviewer flagged as *"shouldnt it be only one"*.

Nothing downstream broke, but every duplicate cost a pin on the map, a repeated
enrichment (up to a Nominatim round trip each, on the ingest deadline) and a
repeated targeting query.

A11 merges on `(settlement, area, region_wide)` and unions the street lists —
which also recovers Игнатиево's typo'd variants as extra match attempts. It runs
last, because every rule above it can create a duplicate that was not in the
parse: A4 splits an entry into siblings that repeat the settlement, A10 can null
an `area` and leave two entries identical, A12 splits one polygon into two.
Polygons never merge, and `region_wide` is part of the key, so a merge can never
widen the narrower entry's audience.

### 2.9 Dropped locations from long lists — still open, still unmeasurable

**Status: open.** Unchanged from the previous edition and confirmed twice more in
this window: `5b048900` lost `м-ст Новите лозя` from the tail of an 18-item list.
Nothing in the output says a place is missing, so no deterministic guard can catch
it. The proposed answer remains a count check, not more prompt prose.

**The eval has still never run.** `backend/spikes/ai-eval` has no Workers AI
credentials in the dev environment, so every prompt and schema change since 28.07
is unvalidated against the corpus — including the four rules this round added to
it (A12, A13, A14 and the invention rule). This remains the single largest
unmeasured surface in the pipeline, and it is now carrying more weight than it
was.

### 2.10 An explicit "улиците:" marker was ignored

**Status: fixed (F13, guard A13).**

epro writes `гр. X – улиците: A, B, C`. A4's promotion rule lifted a street-list
entry into its own location whenever the parent was a bare city and the name
matched a region — and it never looked at the `улиците:` marker that had already
settled the question.

- `5b048900` (гр. Суворово): `Хан Аспарух`, `Георги Бенковски` and
  `Искър(Петлешев)` were lifted out as separate locations and pinned on villages
  — Георги Бенковски onto с. Бенковски at 43.112, 27.789, ~30 km from Суворово.
- `0d59345b` (гр. Вълчи дол): `Васил Левски` became the area (§2.4).

The rule's own docblock justifies itself on `гр. Варна - кв. Младост, ул. X`,
where there is no marker. Where there *is* one, it was overriding an explicit
statement in the source.

A13 is positional, as the marker is: the span runs from the marker to the end of
its sentence, and only entries named inside such a span are exempted from
promotion. A message can carry a marked list beside an unmarked mention, and A4's
own shape still works untouched.

### 2.11 Streets named as a landmark, not as the affected set

**Status: fixed (F15, guard A14).**

`675df786`: *"разположена водоноска на кръстовището между ул. Юпитер и
ул. Сатурн"* — a water truck is **parked** at that junction; the streets are the
remedy's location, not the outage's. Both were stored as affected streets.

Note the near miss: `POLYGON_CUE` includes `между`, so had the sentence named a
third street this would also have been marked a polygon. A14 therefore runs
**before** A2 and takes its streets out of A2's reach.

Two phrases, not the three the plan listed: `водоноска` and `кръстовището между`.
`разположена … на` is ordinary Bulgarian that any sentence about a location can
carry, and a phrase list this small over-fits on one message as it is. The rule is
**positional** — a street is dropped only if it is named after a cue and never
before one — so a message reading "без вода: ул. А, ул. Б. Водоноска на ул. В"
loses only ул. В. Dropping every street whenever the cue appears anywhere would
lose the outage with the remedy.

`378e046a` is the same class in the direction that went *right*: *"от центъра в
посока гр. Варна"* is a bearing, and the model correctly did not extract Варна
from it. Nothing in the prompt said so — it got lucky. It says so now.

### 2.12 Landmark-anchored outages produce no location at all

**Status: open — and it is a product decision, not a bug.**

- `4bf29fce` — *"абонатите около 'Спортна зала'"*
- `4a26aaad` — *"абонатите около х-л 'Флагман'"*

Both parse to zero locations, which the notify side treats as store-only. Neither
is a bug in anything: we hold no gazetteer of buildings. Both are real outages
that notified nobody, and the reviewer's *"did we send city wide for this?"* is
the right question — see §5.1. What has changed is that the Worker now says so:
`Alert '…' notified NOBODY — no locations resolved at all`.

### 2.13 Matcher threshold sits in a measured but narrow gap

**Status: unchanged, and the standing decision is reaffirmed.**

`CORE_MATCH_THRESHOLD = 0.40` was set with clean separation over the 102 distinct
`location_name` values seen at the time — wanted matches ≥ 0.417, false positives
≤ 0.357. New source text can land in that gap in either direction. A real name
that scores 0.35 is a `region_aliases` row, **not** a lower threshold. That table
holds two rows today (both spellings of Владислав Варненчик) and should be grown
from what the review flags.

F8 widens the candidate pool, which is the one thing that could disturb this. The
`м-т Изгрев` case is the collision it was measured against and it is now asserted
explicitly.

## 3. Reach failures — invisible by construction

### 3.1 A settlement-wide alert for Варна reached almost nobody

**Status: fixed (F17), then narrowed by the §5.1 ruling (F19).**

When a location resolved to the **Варна settlement row** and no street survived,
targeting fell through to `getUserIdsByRegion`, which is `WHERE region_id = ?`.
But a user's `region_id` comes from reverse geocoding most-specific-first —
`suburb, neighbourhood, quarter, city_district, city, town, village`
([geocoding.ts:271-273](backend/src/core/geocoding.ts#L271-L273)) — so anyone
genuinely inside the city resolves to their **district**, never to `Варна`. The
settlement row matched only the residue whose reverse geocode hit no district we
seed.

The 31.07 work fixed the *street* leg. The street-less leg was never fixed, and is
reached by three routes: a lone "Варна" with no city-wide phrase (A3 keeps it
deliberately, and its docblock concedes the cost); every named street failing to
match; and A6 `region_wide` firing on an entry whose area resolved.

The fix is containment rather than radius, which is both more exact than the plan
proposed and cheaper: when the matched region is a settlement **that holds seeded
districts**, the audience is every user under the settlement row *or any of those
districts*, plus anyone with a position and no region at all inside 9 km of the
centroid. The second half is the residue — someone whose reverse geocode matched
no district we seed has coordinates and no `region_id`, so no region-keyed query
reaches them however many regions it lists — and it is restricted to
`region_id IS NULL` precisely so a villager 4 km out, who *does* have a region, is
excluded by containment rather than by distance.

"Holds seeded districts" is the test rather than a hardcoded Варна, and it
generalises correctly: villages have no district level under them, so the
settlement row *is* what their residents register under and the plain query stays
right. A region no seeded row claims as its parent is a leaf. For a small town
like Белослав, where three districts are seeded and most of the town is in none of
them, the union of the settlement row and its districts is both correct and
complete.

**Then §5.1 was decided, and the city was taken back out.** *A failed extraction
notifies nobody* — so the one settlement this section was written about is now the
one it does not apply to. A genuine whole-city outage is published in words and
routed to `city_wide`, which has its own fan-out; a location resolving to the
Варна row with no area and no matched street is therefore, by construction, a
district that got lost. Widening it to ~90 districts would have been a city-sized
push decided by an extraction already known to have failed — the inverse of the
trade A3's docblock has stated since 28.07 ("region-wide Варна reaches far fewer
people than it should, but never people the message was not about").

That leaves this section's machinery serving the towns rather than the city, which
is the smaller win it was originally credited with — and the honest one. Reaching
nobody is still a bad outcome; the difference is that it is now loud (§3.2) rather
than silent, which is what makes it recoverable.

**A second half, found while re-seeding.** The ordering inside `settlementScope`
mattered as much as the query: it asked the parent-link question before the
written-kind question, so `с. Припек` could resolve to the *suburb* of that name
and be answered with Константиново's centroid even once the village row existed
again (§1.2). A name that states its own settlement kind is never a district of
something else, so that lookup now goes first.

### 3.2 An empty audience was silent

**Status: fixed (F1).**

```ts
if (filteredIds.length === 0) return { recipients: filteredIds, delivered: true };
```

No log line. Every failure in this document terminates here and the pipeline
reported success: the alert is stored, `notified_at` is stamped, the cursor
advances, and nothing distinguished "correctly reached nobody" from "the matcher
lost the district and 40,000 people were not told the water is off".

The 8% figure at the top of this file exists only because `targeting.py` was
written to recompute it offline, weeks later, against a 5-row users table. The
Worker itself had never said a word about it.

It does now, at three levels:

- per alert, when the final audience is empty, with a trace per location;
- per location, whenever one resolves to nothing at all — §3.3's twenty were all
  inside alerts that reached someone through a *different* location, so an
  alert-level check alone would have missed every one of them;
- per resolution, for the two silent decisions underneath: `settlementScope`
  returning null (§3.4) and `matchRegion`'s unscoped retry escaping its scope
  (§2.4).

The trace shape deliberately mirrors `targeting.py`'s per-location record —
`method`, `settlement`, `region`, `streets`, `note` — because the live logs and
the offline simulator are meant to stay comparable.

### 3.3 Twenty locations targeted nobody, and all of them were localities

**Status: three fixed by F8; eleven wait on the re-sweep (F5).**

20 of 248 locations resolved to no region and no street. Every one is a `м-т`, and
they split cleanly into the two causes already named — §1.4 (eleven names with no
seeded row at all) and §2.3 (three names whose row exists but was kind-rejected:
Ален мак, Добрева чешма, Изгрев).

This is the concrete, countable form of what §3.2 hid.

### 3.4 Anything outside the seeded settlements silently targets zero

**Status: unchanged behaviour, now logged (F1); sharpened by the §1.1 prune.**

`settlementScope` returns `null` when it cannot place a location, and the street
path is gated on `settlement !== null`. If the region match also fails,
`getUserIdsInRange` returns `[]`.

That gate is right — an unscoped street match is what used to notify Varna
residents about a Долни чифлик outage 30 km away — but the audience for an
unseeded settlement is exactly zero, and nothing said so. ViK publishes for the
whole province. It now warns by name.

The §1.1 prune changes the shape of this deliberately. Before it, the eleven
polluted settlements had rows, so the gate did *not* fire and targeting proceeded
confidently against street ids belonging to another town. Now those settlements
have fewer streets or none, the gate fires, and the alert falls back to
region-wide — coarse, correct, and audible. That is the right direction to fail
in.

### 3.5 Polygon alerts had no fallback and no tolerance

**Status: fixed (F18).**

`is_polygon` takes an exclusive branch in `sendUsersNotification` with no
region-level fallback behind it. Two exposures followed: a user must have
coordinates at all, and a pin a few metres outside the ring was a miss with no
margin.

In this window the exposure never materialised — every polygon failed to build, so
every one of them fell back to street/region targeting (§2.1). That is luck, not
design: the day the geometry starts succeeding, this branch starts deciding
audiences, and F6 is that day.

Both halves now have a floor. A ring gets a **30 m tolerance band** — roughly one
building depth, which is what it takes to absorb three stacked errors (the ring
edge sits 12 m off an OSM centreline, the centreline is sketched, and the point is
a phone's GPS fix) while staying too narrow to reach across the street into the
next block. And a ring that matches **nobody** falls through to the street/region
audience the location would otherwise have had, because an empty ring is equally
"the geometry is wrong" and "these residents have not set a location". The bbox
prefilter is widened by the same tolerance, or the band would do nothing at the
corners.

## 4. Delivery — alerts that never get sent at all

### 4.1 An unprocessable message pins the cursor forever

**Status: the cheap half shipped (F21). The real fix remains a product decision.**

The crawler is oldest-first and advances only past successes. `MAX_PUSH_ATTEMPTS`
caps a dead push, but **nothing caps a message that fails before the store**. On
30.07.2026 one over-budget message turned into a 20-hour ingestion outage and six
unsent ViK outages.

The awkward part is real: an `exceededCpu` kill runs no further code, so an
attempt counter has to be written *before* the heavy work and cleared on success —
one extra D1 write per message per tick — and then N strikes means deliberately
skipping a public-safety alert. A product decision, not a refactor.

What shipped is the alarm: `runIngestion` ends by checking every source's
`crawl_state.updated_at` and logging an error past **6 hours**. The threshold is
set against the *quietest* source — vt and heating publish a handful of items a
week, so anything tighter cries wolf on an ordinary quiet night — and is well
inside the 20-hour outage it exists to catch. It swallows its own failures: a
monitor that can break ingestion is worse than no monitor.

### 4.2 Workers AI timeouts eat the tick budget

**Status: open, unmeasured.** Measured over the three recovery ticks on
30.07.2026: **6 × `AI.run timed out after 30000 ms` against 8 messages ingested**,
one epro message exhausting all three attempts. Spike 2 clocked qwen3-30b at
4–21 s, which is what `RUN_TIMEOUT_MS = 30_000` was sized for; it is now routinely
past it.

One message can burn ~90 s in retries against a `DEADLINE_MS` of 300 s. Past the
deadline the runner starts skipping sources — so this degrades into **missed**
alerts, from a direction the deadline design did not anticipate: it assumed the AI
was fast and Overpass was the risk.

Do not simply raise the timeout; that makes starvation more likely, not less.

### 4.3 Cadence

The crawl runs every 15 minutes (`wrangler.jsonc`). Nothing about that is wrong,
but it is the floor on how late any alert can be, and worth stating when a
"missed" alert is really a late one.

## 5. Open product decisions

### 5.1 When does an unmatched area mean "notify the whole settlement"?

**Decided 10.08.2026: a failed extraction notifies nobody.** Shipped as F19.

The reviewer's framing on `fa675662`:

> *"Varna is a big city and it lives on the same level as a small village. If an
> alert is talking about a small village (no area) it should notify everyone in
> the given village, but about Varna — if it didn't match an area, should we send
> a city wide?"*

The answer draws the line where the reviewer drew it. **A village or a town with
no area is a real settlement-wide statement** and notifies the settlement — that
is what ViK publishing "абонатите на гр. Бяла" means, and it is unchanged.
**Варна with no area is not a statement, it is a failure**, because a genuine
whole-city outage is published in words and routed to `city_wide`. So it notifies
nobody.

Three routes reach that state and all three are extraction failures: the model
dropped the district (§2.7), every named street failed to match, or the message
named a landmark we hold no gazetteer for (§2.12 — `Спортна зала`, `х-л Флагман`).
None of them is evidence about who is affected, and none of them earns a
city-sized push.

What makes this acceptable rather than merely safe is F1: the outcome is now
logged per alert and per location, with the resolution that produced it. Before,
"reached nobody" and "reached everyone" were the same silence.

### 5.2 Do we notify only the listed streets, or the whole settlement?

The reviewer's question on `803a51e4` (Долни чифлик, six streets): *"we notify
only the people who are on these streets not the whole city right?"* Answer as the
code stands: **yes** for a village — matched street ids, plus users in the region
with no street of their own. Worth confirming that is the intent, because in a
village where we hold 42 streets and the message names six, a resident whose
street we matched to the wrong row hears nothing.

*(The previous edition said 97 streets for Долни чифлик; the seed holds 42. 97 is
Провадия's count.)*

### 5.3 The pre-store attempt counter (§4.1) and the AI count check (§2.9)

Both carried over, both unchanged, both still decisions rather than refactors.

## 6. What is *not* a pitfall

Recorded so it is not re-litigated:

- **City-wide broadcasts to the whole province.** Fixed. `CITY_WIDE_RADIUS_KM = 15`
  drops only users we can *prove* are far away; users with no position stay in.
- **An invented `city_wide: true`.** Guarded both directions by A8/A3. Zero
  unintended broadcasts in 131 alerts.
- **A bare area with no settlement defaulting to Varna.** `2b1af455`
  (`кв. Възраждане 2`) resolved correctly via `DEFAULT_SETTLEMENT`. The reviewer's
  *"if its just an area we should probably assume that its in Varna"* is already
  the behaviour — the failure in §2.7 is different, because there the message
  **did** name a settlement and the model dropped it.
- **epro's `гр. X - кв. Y` districts.** Handled by A4 on the shape it was written
  for; §2.10 is a distinct shape, not a regression.
- **Multi-day windows.** `0d59345b` rendered as a recurrence
  (`from 08-10 to 08-14, daily 09:00–17:00`) exactly as the schedule model
  intends.
- **Village streets matching like-named Varna streets.** Fixed by settlement
  scoping in `matchStreet` — and as of F6 the polygon path, the last holdout, uses
  the same call.
- **A Nominatim blip erasing a user's targeting.** Fixed — a failed lookup keeps
  the existing columns.
- **Matcher CPU cost.** 11.6 ms → 1.27 ms by moving per-name work to module
  evaluation. The in-memory trigram index remains deferred and would not have
  helped, since an index is still built per isolate.
- **Rewriting seeded street names to a canonical prefix form.** Considered and
  rejected with a reason — §1.3. The stored name is what goes to Overpass.

---

# Part II — What was done

## Shipped

**Diagnostics (F1, F2).** `sendUsersNotification` warns on an empty audience with
a per-location trace, per location for any that targets nobody, and on the two
silent resolutions underneath (`settlementScope` null, `matchRegion` escaping its
scope). A failed polygon build is recorded as `polygon_failed` + `polygon_failure`
inside `locations_json` — no migration — and `tools/alert-review` reads and renders
both, so its dedicated badge is reachable for the first time.

**Seed tool (F3, F4, F5).** The province sweep keys each per-settlement request on
the boundary relation's OSM element id; an ambiguous name is reported and skipped
rather than unioned; extractions beyond 15 km are dropped and reported; a name
that is only a kind word is dropped; `locality` joins `DISTRICT_PLACES`. Two rules
were corrected after the first live run exposed them: a district may not displace
a **settlement** row of the same name (which is what had deleted `с. Припек`), and
the "this district is really a settlement" refusal only fires within 2 km (without
which it also refused the resort suburb `Чайка`, 50 km from the village of that
name).

**Seed data.** 420 mis-filed streets and one unusable name were pruned as a
stopgap, then the corrected sweep replaced the whole extraction on 10.08.2026:
**350 regions (177 linked) and 2,565 streets across 54 settlements**, up from 260
and 2,974-with-420-wrong. Zero settlements skipped, zero distance-backstop hits.
`seeds/verify.mjs` and `test/seeds.spec.ts` hold the invariants.

**Polygons (F6, F7, F18, §2.1 Cause B).** `buildPolygonForStreets` takes the
location's settlement, resolves through `matchStreet` inside it, pins
`admin_level=8` (now measured, not assumed), discards ways beyond 12 km of the
centroid, falls back to `around:` for settlements OSM gives no boundary, and folds
curated OSM spelling variants under the resolved name. A12 splits two-block
messages. Polygon targeting gained a 30 m tolerance band and a street/region
fallback. **Verified against live Overpass**: `5d34f795` closes a 112-point ring,
`d29913c5` builds both of its blocks, and its source typo `ул. Звзда` recovers to
`Звезда`.

**Matcher (F8, F9).** `м-т`/`с.о.`/`кв.`/`ж.к.` share one class; `к.к.` does not.
Geocoded points are checked against the stated settlement's own measured extent.
`settlementScope` resolves a written `гр.`/`с.` as a settlement before consulting
any parent link.

**Parse (F11–F15).** A10 (invention), A11 (duplicates), A12 (two blocks), A13
(`улиците:`), A14 (remedy streets), plus the heating-is-Варна constant. The prompt
carries all of them as a second line of defence.

**Reach and delivery (F17, F19, F21).** Settlement-wide targeting reaches a town's
districts and its unplaced residents; the **city** notifies nobody by name alone,
per §5.1. Reverse geocoding learned the `locality` level, without which the ~90 new
locality rows could be named by an alert and never carry a user. The tick reports a
cursor that has not moved in 6 hours.

**Tests.** 476 passing across 25 files, up from 436, keyed to the alerts they come
from: `40b78a66` (A10), `d29913c5` (A12), `5b048900` (A13), `675df786` (A14),
`52e21c59`/`c12154c9` (A11), `0220dec1` (F8), `803a51e4`/`8360abda` (F9),
`5d34f795` (the spelling fold), both directions of F17/F19 and of F18.

## Not done, and why

**F16 (the AI eval).** No Workers AI credentials in the dev environment. Four
prompt rules were added this round (A12, A13, A14, invention) and none is validated
against the corpus. `5b048900` (18 items, one dropped) and `40b78a66` (invention)
should go into the corpus before it next runs. **This is now the largest unmeasured
surface by some distance.**

**Nine of §1.4's eleven localities.** OSM holds no feature of those names — not a
place, not anything. They need hand-written rows with locally-known coordinates or
aliases onto whatever district contains them, and neither can be derived, so
neither was invented here. `Траката` is answered by an alias; `Ракитника` is now
seeded.

**`Гръцката махала` under Бяла (part of F10).** Бяла has 55 correct streets after
the re-sweep and **no districts** — OSM maps none — so there is still no row for an
alias to point at. §2.7's `fa675662` therefore still resolves to Varna's district
of that name when the model drops the settlement.

**F20.** Needs a week of `wrangler tail` or a log sink.

**Purging the poisoned `geocode_cache` rows** behind §2.5, and **applying the new
seed to D1**. Both are deploy actions; see below.

## Applying this

The repo is consistent and the suite is green, but nothing has been applied to a
database or deployed. In order:

1. `npm run db:local` — migrations, `seeds/generate-seed.mjs`, apply. Then
   `node seeds/verify.mjs` and `npx vitest run test/seeds.spec.ts`.
2. The remote D1 still holds the **420 mis-filed street rows**: `seed.sql` is an
   upsert and never deletes, so applying it adds and corrects but does not remove
   them. A wipe-and-reseed is the only way to drop them — routine here, since the
   app is unreleased, but **preserve `users` by name and leave `crawl_state`
   alone**; resetting the cursor would replay history into `alerts` and destroy
   the evaluation window.
3. `DELETE FROM geocode_cache` for the poisoned entries (§2.5), or the plausibility
   check does nothing for names already cached.
4. Redeploy — `seeds/*.json` is bundled and feeds the module-scope memo, so the
   deploy is part of the seed fix rather than an afterthought. Watch the startup
   budget `wrangler deploy` prints: 27 ms against 400 ms last measured, and the
   seed has grown by ~90 regions.
5. Re-run the review over a fresh window. The structural-reach table at the top of
   this file is the number to re-measure, and `polygon_failed` is now the query
   that answers whether the polygon path is working without opening a map.
