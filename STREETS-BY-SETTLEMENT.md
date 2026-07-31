# Streets by settlement — execution plan

**Status:** proposed, not started. Written 31.07.2026.
**Goal:** give `streets` a settlement dimension so village streets can be seeded,
ingest stops calling Nominatim for them, and street targeting stops confusing a
village street with the Varna street of the same name.

This is a working document. When the change lands it folds into SPEC.md §1.2/§1.5
and this file is deleted — the same treatment PLAN.MD got.

---

## 1. Why

`streets` is Varna-only and `street_name` is globally `UNIQUE`. Two consequences,
one known and one found while writing this:

**Coordinates.** `resolveCoordinates` refuses a seeded street whenever the
location's settlement is not Варна (`alert-service.ts:516`), because the seeded
row would be the *city's* street — that guard is what fixed the Долни чифлик
mis-pin (`d9d3805`). So every village location falls through to Nominatim: a
1,100 ms throttle slot plus an up-to-8 s request, per street, on the ingest
deadline. Regions and streets have carried coordinates since migration 0005
precisely to avoid this, and villages get none of that benefit.

**Targeting (live bug).** `getUserIdsInRange` calls `matchStreet` against the
same global table with no settlement scope at all. When a region resolves, the
`region_id = ?` in `getUserIdsByStreets` masks the problem. When one does not —
which the code notes is routine for vik, *"vik routinely names streets and no
district at all"* — the query is `street_id IN (…)` across the whole table, so a
Долни чифлик street outage notifies Varna residents of the same street name.

**It cannot be dodged by picking non-colliding names.** Overpass, streets within
~2.5 km of Тополи, Аврен and Долни чифлик: **94 distinct names, 49 of them (52%)
already in the Varna seed** — `ул. Тича`, `ул. Люляк`, `ул. Черно море`, all
eleven `ал. N`. Half the incoming data would be silently swallowed by the merge's
name key and the `UNIQUE` constraint behind it.

## 2. Shape of the change

`streets` gains **`region_id INTEGER NOT NULL REFERENCES regions(id)`**, and the
uniqueness moves from `street_name` to `(street_name, region_id)`.

**Why an FK and not a `settlement TEXT` column.** `regions` already holds all 252
settlements *with coordinates*; a street's settlement is a row that exists.
Targeting already speaks region ids (`getUserIdsByStreets(ids, regionId)`), so
scoping a match by the same integer introduces no new vocabulary. Migration 0014
renamed five regions in place specifically so ids would not orphan — a text
column would re-introduce exactly that fragility, plus name normalization
("Варна" vs "гр. Варна") at every lookup.

**The objection that does not land.** `regions` cannot distinguish a settlement
(Аврен) from a Varna district (кв. Виница): only 52 of 252 rows carry a kind
prefix, and bareness is not a tell either — Галата is a district with a bare
name. But nothing ever has to ask. The seeder extracts *per area*, so it knows
which settlement it queried; and at lookup time `settlementOf()` already collapses
every `кв.`/`ж.к.`/`м-т`/`с.о.` to `"Варна"`, so a district can never reach the
column. The invariant is **`streets.region_id` always points at a settlement-class
region**, upheld at write time, not discoverable from the data.

`NOT NULL` is load-bearing: SQLite treats NULLs as distinct in a UNIQUE index, so
a nullable column would let `('ул. Тича', NULL)` be inserted twice and quietly
re-open the ambiguity.

## 3. Scope — which settlements to seed

**Phase in община Варна first** (the ~99 regions inside the 15 km citywide radius),
not all 252. Two reasons: it is where the users are, and row growth is the main
risk to the CPU budget (§7). Extend outward to the rest of the province — vik does
publish Долни чифлик and Аврен — only after §7's measurement holds.

## 4. Execution

Seven steps. Each is separately committable and separately revertible, and the
order is chosen so nothing is deployed that depends on data not yet applied.

### Step 0 — Spike the rebuild against local D1 *(do this first, it can veto the plan)*

SQLite cannot drop a `UNIQUE` constraint in place, so this needs the documented
12-step table rebuild. There is **no rebuild precedent in this repo** — every
migration so far only adds or drops — and `users.street_id REFERENCES streets(id)`
means row ids must survive it.

Write the migration, apply it to a **local** D1 with rows in `users` pointing at
`streets`, and confirm: ids preserved, FK intact, no orphaned `street_id`.

```sql
CREATE TABLE streets_new (
  id INTEGER PRIMARY KEY,          -- no AUTOINCREMENT: ids are copied verbatim
  street_name TEXT NOT NULL,
  region_id INTEGER NOT NULL REFERENCES regions(id),
  lat REAL, lng REAL,
  UNIQUE(street_name, region_id)
);
INSERT INTO streets_new (id, street_name, region_id, lat, lng)
SELECT s.id, s.street_name, (SELECT id FROM regions WHERE region_name = 'Варна'), s.lat, s.lng
FROM streets s;
DROP TABLE streets;
ALTER TABLE streets_new RENAME TO streets;
```

Open questions the spike answers, and which decide whether this step is cheap or
becomes the whole problem:

- Does D1 allow `DROP TABLE` on a table another table references? Needs
  `PRAGMA foreign_keys=OFF` or `defer_foreign_keys`, and D1's handling of pragmas
  inside a migration is the thing to verify, not assume.
- Does `ALTER TABLE … RENAME TO` rewrite `users`' FK clause to point at the new
  table (modern SQLite) or leave it dangling (`legacy_alter_table`)?

**If D1 refuses the rebuild**, fall back to the coordinates-only design (a
separate `settlement_streets` table read solely by `resolveCoordinates`). It
fixes the Nominatim half and leaves the targeting bug open — a worse outcome,
but a real one, and better than discovering the blocker halfway through step 4.

The backfill hardcodes `'Варна'`. Assert it resolved rather than trusting it:
a missing regions row would make `region_id` NULL and the `NOT NULL` would fail
the migration loudly, which is the behaviour we want.

### Step 1 — Migration `0015_streets_by_settlement.sql`

The verified statements from step 0, plus:

- `CREATE INDEX ix_streets_region ON streets(region_id)` — the matcher filters on it.
- Cleanup, as its own reviewable statement: users outside Варна whose `street_id`
  points at a Varna street were assigned it by the reverse-geocode path and are
  wrong today. `UPDATE users SET street_id = NULL WHERE region_id IS NOT NULL AND
  region_id <> (SELECT id FROM regions WHERE region_name = 'Варна') AND street_id
  IS NOT NULL;` — a NULL `street_id` reads as "somewhere in this region" and is
  already handled by `getUserIdsByStreets`, so this widens those users to
  region-level rather than silencing them.

### Step 2 — Seed format and generator

`seeds/streets.json` entries gain a `settlement` **name** (not an id — autoincrement
ids differ between local and remote, which is why `aliases.json` is keyed by name).
The existing 1333 entries all take `"settlement": "Варна"`.

```jsonc
{ "name": "ул. Тича", "settlement": "Аврен", "lat": 43.11, "lng": 27.66 }
```

`generate-seed.mjs` switches the streets insert to the `INSERT … SELECT` form
`insertAliases` already uses, resolving the name at apply time:

```sql
INSERT INTO streets (street_name, region_id, lat, lng)
SELECT 'ул. Тича', id, 43.11, 27.66 FROM regions WHERE region_name = 'Аврен'
ON CONFLICT(street_name, region_id) DO UPDATE SET
  lat = COALESCE(excluded.lat, streets.lat),
  lng = COALESCE(excluded.lng, streets.lng);
```

This costs the 100-row `VALUES` batching — ~1300+ statements instead of ~14. If
apply time becomes annoying, batch it as `VALUES (…),(…) JOIN regions ON
region_name = settlement`; do the simple version first and only optimize if the
apply is actually slow.

**A street whose settlement is missing from `regions` inserts nothing, silently.**
That is the same failure mode `insertAliases` accepts, but it matters more here.
Have the generator print the count it emitted, and add a post-apply check that
`SELECT COUNT(*) FROM streets` matches.

Update `test/seed-upsert.spec.ts` — it mirrors `insertBatches` and pins the
COALESCE semantics, so it has to mirror the new statement shape.

### Step 3 — `osm-seed-builder`

- `merge_into_seed` keys on `(name, settlement)` instead of `name`. Its docstring
  currently says the key is *"the same key the UNIQUE constraint uses"* — that
  stays true, the constraint just moved.
- `load_seed`/`save_seed` carry the field through; sort by `(settlement, name)` so
  diffs stay readable.
- The extraction already runs against one resolved area, so the tool knows the
  settlement — stamp it onto the rows server-side from the resolved area's name
  rather than trusting the client to send it.
- `seed_status`'s name lists (which drive the "not in output"/"not in backend"
  counts in the UI) need the same key, or the UI will report every village street
  as already present.
- README: the "Seed file format" and "Adding new data later" sections both
  describe the name key and need updating.

### Step 4 — Matcher

`NamedRow` gains an optional `region_id`; `getStreets` selects it.

`matchCore` takes an optional `scopeRegionId` and skips rows whose `region_id`
differs, **inside the existing loop**. Do not pre-filter the array at the call
site: `prepare()` memoizes trigrams on array *identity*, so a freshly filtered
array on every call throws the memo away and re-parses every row — the exact cost
that memo exists to avoid, on a 10 ms budget.

`matchStreet(raw, rows, scopeRegionId, threshold)`. Its docstring's reasoning
("no in-city preference: street_name is unique across the table") is about to stop
being true and needs rewriting.

### Step 5 — Call sites

| Site | Scope comes from |
|---|---|
| `resolveCoordinates` | already computes `settlementOf(dto.location_name)`; match it to a region for the id. Then **delete the `settlement === "Варна"` guard** — that is the point of the change |
| `getUserIdsInRange` | `matchRegion(settlementOf(locationName))` — note this is *not* the same as the existing `region` match: for "кв. Виница" the region is the district but the street's settlement is Варна |
| `PUT /api/auth/location` | the settlement-level name from the reverse-geocoded address (`city`/`town`/`village`), matched to a region. This is what stops new village users being assigned a Varna street |

Fallback rule to decide once and apply everywhere: **an unresolvable settlement
scopes to nothing rather than to everything.** Falling back to an unscoped match
would silently restore today's bug on exactly the inputs that trigger it.

### Step 6 — Apply to the database

Order matters, and the remote step is the only irreversible one:

1. `wrangler d1 migrations apply --local`, then the full test suite.
2. Re-extract община Варна's settlements in the seed builder, merge into
   `output/`, generate SQL, apply `--local`. Verify the row count.
3. Promote to `backend/seeds/`, review the git diff (it should be additions plus
   a `settlement` field on every existing row, nothing else).
4. **Back up remote first** — `wrangler d1 export cityshield-db --remote
   --output=backup-pre-0015.sql`. The rebuild drops a table; there is no undo.
5. `wrangler d1 migrations apply --remote`, then `wrangler d1 execute --remote
   --file=…`.
6. Post-apply checks: street count matches the JSON; no user has a `street_id`
   whose street's `region_id` disagrees with the user's `region_id`; spot-check
   that a known village street resolves without a Nominatim call.

## 5. Verification

- Existing 392 tests pass unchanged except `seed-upsert.spec.ts` (step 2) and any
  test constructing a `streets` row.
- New: a village street and a Varna street sharing a name resolve to different
  rows, different coordinates.
- New: a street-only alert in a village does **not** notify a Varna user on the
  like-named street — the live bug, pinned.
- New: `PUT /location` for a village point assigns that village's street.
- New: the migration preserves `users.street_id` for city users.
- Manual: watch a real vik village message through `wrangler tail` and confirm no
  `Skipping uncached geocode` / no Nominatim slot taken for its streets.

## 6. What this does **not** do

- Does not touch the `city_wide` radius (shipped separately, `536efed`).
- Does not fix the [Varna targeting bug](TODO.md) — "Варна" + streets still
  notifies almost nobody. Related, deliberately separate.
- Does not reduce reverse-geocode calls on `PUT /location`; that path is
  inherently uncached and stays the main Nominatim consumer.

## 7. Risks

**Trigram preparation on a bigger table — the one that could bite.** `prepare()`
builds trigrams for *every* row on first call per cached array, in one synchronous
burst. The 10 ms CPU cap applies to a burst, not to the invocation
(`cold-isolate-cpu-outage`, 30.07.2026) — this is exactly the shape that caused
that outage. At 1333 streets it is fine; nobody has measured it at 6000.

Mitigation, in order: measure `prepare()` at the projected row count *before*
seeding remote; if it is close, prepare lazily per settlement rather than per
table, which also makes the steady-state match cheaper than today (the scope
filter skips non-settlement rows before `gramSimilarity`). This is the same
pressure the deferred in-memory trigram index was meant to relieve — if it turns
out to be the blocker, that work becomes a prerequisite rather than an option.

**Silent under-insert.** A street whose settlement is missing from `regions`
inserts nothing. Covered by the count check in step 2/6, and the reason it is a
check rather than a hope.

**The rebuild.** Step 0 exists to find out early. Back up before remote.

**Row-count growth on the D1 free plan**, which bills rows *examined* — 
`getStreets` reads the whole table into the 6-hour cache. Once per cache fill, so
the ceiling is bounded, but worth watching after the first extract.
