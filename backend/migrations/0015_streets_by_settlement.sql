-- Give streets a settlement dimension, so village streets can be seeded at all.
--
-- `streets` was Varna-only and `street_name` was globally UNIQUE, which cost us
-- two things. Every village location fell through to Nominatim, because a
-- seeded row could only ever be the *city's* street (the guard in
-- resolveCoordinates that fixed the Долни чифлик mis-pin) — a 1,100 ms throttle
-- slot plus an up-to-8 s request, per street, on the ingest deadline. And street
-- targeting matched against the same global table with no settlement scope, so
-- an outage on a Долни чифлик street notified Varna residents of the like-named
-- one whenever no region resolved alongside it (routine for vik, which names
-- streets and no district).
--
-- Neither is dodgeable by picking non-colliding names: of the 94 distinct street
-- names Overpass returns around Тополи, Аврен and Долни чифлик, 49 (52%) already
-- exist in the Varna seed, so the global UNIQUE would swallow half the data.
--
-- An FK to regions rather than a `settlement TEXT`: regions already holds every
-- settlement *with coordinates*, targeting already speaks region ids, and 0014
-- renamed regions in place precisely so ids would not orphan. NOT NULL is
-- load-bearing — SQLite treats NULLs as distinct in a UNIQUE index, so a
-- nullable column would let ('ул. Тича', NULL) be inserted twice and quietly
-- re-open the ambiguity this migration exists to close.
--
-- The invariant `streets.region_id` always points at a *settlement*-class region
-- (Аврен, Варна), never at a Varna district (кв. Виница), is upheld at write
-- time and is not discoverable from the data — regions cannot tell the two
-- apart. Nothing has to ask: the seeder knows which settlement it queried, and
-- at lookup time settlementOf() collapses every кв./ж.к./м-т/с.о. to "Варна".

-- ── The rebuild ──────────────────────────────────────────────────────────────
--
-- SQLite cannot drop a UNIQUE constraint in place, so the table has to be
-- rebuilt — and `users.street_id REFERENCES streets(id)` makes that awkward.
--
-- The documented 12-step rebuild says to turn `PRAGMA foreign_keys` off for the
-- duration, which D1 does not allow (it is not in D1's supported-pragma set, and
-- SQLite refuses it inside a transaction in any case). `PRAGMA defer_foreign_keys
-- = ON` is supported and looks like the answer, but is not: DROP TABLE performs
-- an implicit DELETE FROM, which counts one deferred violation per referencing
-- row, and recreating the table under the same name afterwards never decrements
-- that counter — so the COMMIT fails. Verified against local D1: the whole
-- migration rolled back with "FOREIGN KEY constraint failed".
--
-- So the children are detached instead: park every users.street_id, null the
-- column, rebuild, then put the ids back. Nothing references `streets` at the
-- moment it is dropped, so no violation is ever counted and no pragma is needed.

CREATE TABLE streets_rebuild_backup (
    user_id   TEXT PRIMARY KEY,
    street_id INTEGER NOT NULL
);

INSERT INTO streets_rebuild_backup (user_id, street_id)
SELECT user_id, street_id FROM users WHERE street_id IS NOT NULL;

UPDATE users SET street_id = NULL WHERE street_id IS NOT NULL;

-- AUTOINCREMENT is kept from 0001, not dropped: it is what guarantees a street
-- id is never reused. Ids are copied verbatim either way (the INSERT below names
-- the id column), so keeping it costs nothing and preserves the property
-- users.street_id depends on.
CREATE TABLE streets_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    street_name TEXT NOT NULL,
    region_id   INTEGER NOT NULL REFERENCES regions(id),
    lat         REAL,
    lng         REAL,
    UNIQUE(street_name, region_id)
);

-- Every existing row is a Варна street — that is exactly what the table was.
-- The lookup is not defended against a missing regions row on purpose: it would
-- yield NULL, and the NOT NULL above then fails the migration loudly, which is
-- the behaviour we want from a backfill that cannot be half-right.
INSERT INTO streets_new (id, street_name, region_id, lat, lng)
SELECT s.id, s.street_name, (SELECT id FROM regions WHERE region_name = 'Варна'), s.lat, s.lng
FROM streets s;

DROP TABLE streets;

-- users' FK clause names `streets` and is left untouched by this rename (SQLite
-- only rewrites references to the table being renamed, i.e. to `streets_new`),
-- so the reference simply resolves again once the name is back. Verified on
-- local D1: the clause still reads `REFERENCES streets(id)` afterwards and is
-- still enforced.
ALTER TABLE streets_new RENAME TO streets;

-- The matcher filters on this column once street matching is settlement-scoped.
CREATE INDEX ix_streets_region ON streets(region_id);

UPDATE users SET street_id = (
    SELECT b.street_id FROM streets_rebuild_backup b WHERE b.user_id = users.user_id
) WHERE user_id IN (SELECT user_id FROM streets_rebuild_backup);

DROP TABLE streets_rebuild_backup;

-- ── Cleanup ──────────────────────────────────────────────────────────────────
--
-- Separate from the rebuild above, which is deliberately lossless.
--
-- A user outside Варна whose street_id points at a Varna street was assigned it
-- by the reverse-geocode path — PUT /location matched the street name Nominatim
-- returned against a table that only held city streets, so it could only ever
-- come back with a city street. Today that stale id is merely useless. After
-- this change it is harmful: once village streets are seeded, a village alert
-- resolves to real village street ids, and getUserIdsByStreets selects
-- `street_id IN (…) OR street_id IS NULL` — so a villager still holding a Varna
-- street_id is neither in the list nor NULL, and gets *excluded* from an alert
-- that today reaches them region-wide. Clearing it widens them back to region
-- level, and they get their real street the next time they send a location.
--
-- Which rows are wrong is not answerable from region_id: `regions` cannot tell a
-- settlement from a Varna district (203 of 252 names carry no kind prefix, and
-- Център, Максуда and Галата are bare city sub-areas sitting right next to bare
-- villages like Тополи and Казашко). Comparing region_id against Варна's row
-- would clear nearly every city user.
--
-- So the test is one that needs no settlement knowledge at all and is sound in
-- the only direction that matters: clear a street assignment only when the user
-- and the street they point at are provably far apart. A box rather than a
-- haversine — SQLite has no trig, and this wants a generous threshold anyway,
-- because a street's seeded coordinate is a crude average over the whole way and
-- a long boulevard legitimately lands a couple of kilometres from a resident.
-- 0.045° of latitude and 0.062° of longitude are each ~5 km at this latitude.
--
-- Sound, not complete: a user whose row (or whose street) carries no coordinates
-- cannot be judged and is left alone, and so is a villager who happened to be
-- assigned a Varna street that is close by. Those keep today's behaviour rather
-- than being cleared on a guess.
UPDATE users SET street_id = NULL
 WHERE street_id IS NOT NULL
   AND latitude IS NOT NULL AND longitude IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM streets s
        WHERE s.id = users.street_id
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
          AND (ABS(s.lat - users.latitude) > 0.045 OR ABS(s.lng - users.longitude) > 0.062)
   );
