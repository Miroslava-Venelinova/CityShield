-- Let a district name repeat across settlements, the way migration 0015 let a
-- street name repeat.
--
-- `region_name` has been globally UNIQUE since 0001, which forced a real place
-- to be renamed whenever two settlements happened to share a district name.
-- 0014 did that by hand — "ж.к. Младост (Белослав)" — and the province sweep
-- had to keep doing it: Варна and Белослав each have a genuine "Цветен квартал",
-- 17.5 km apart, and only one of them could hold the name.
--
-- A parenthesised settlement is a poor key. No source writes it: an outage
-- message says "Цветен квартал", never "Цветен квартал (Белослав)", so the
-- suffixed row is reachable only through fuzzy matching against a string nobody
-- produces — while the *fact* that distinguishes the two places already sits in
-- the row, as settlement_id (0016). Keying on it is what this migration does.
--
-- ── Why COALESCE and not a plain UNIQUE(region_name, settlement_id) ───────────
--
-- SQLite treats NULLs as distinct in a UNIQUE index — the trap 0015 called out
-- and dodged by making streets.region_id NOT NULL. Here NULL is not avoidable:
-- it is what marks a row as a settlement rather than a district, and that is the
-- whole design of 0016. A plain two-column UNIQUE would therefore constrain the
-- districts and leave the *settlements* — the rows everything else resolves by
-- name — with no uniqueness at all, so "Варна" could be seeded twice and every
-- `WHERE region_name = 'Варна'` lookup would start returning two ids.
--
-- An expression index over COALESCE(settlement_id, 0) folds those NULLs onto one
-- value, restoring exactly the old guarantee for settlements while letting
-- districts repeat per parent. 0 is safe as the sentinel: `id` is INTEGER
-- PRIMARY KEY AUTOINCREMENT, which never issues 0. D1 supports both the
-- expression index and an upsert whose conflict target repeats the expression —
-- verified against local D1 before this was written, since seeds/seed.sql
-- depends on that upsert form.
--
-- ── The rebuild ──────────────────────────────────────────────────────────────
--
-- The old constraint is a column-level UNIQUE, so SQLite implements it as
-- sqlite_autoindex_regions_1, which cannot be dropped. The table has to be
-- rebuilt, and four things reference it: users.region_id (nullable),
-- regions.settlement_id (nullable, self), region_aliases.region_id (NOT NULL)
-- and streets.region_id (NOT NULL, 0015).
--
-- 0015 established why the documented rebuild does not work on D1: `PRAGMA
-- foreign_keys` is not settable, and `defer_foreign_keys` does not help because
-- DROP TABLE counts one deferred violation per referencing row and recreating
-- the table never decrements it. So the same remedy is used and widened — every
-- child is detached before the drop, and put back after. The two NOT NULL
-- children cannot be nulled in place, so their rows are parked wholesale;
-- parking `streets` in turn means parking users.street_id, which references it.
--
-- Nothing references `regions` at the moment it is dropped, so no violation is
-- ever counted. Ids are preserved verbatim throughout, so every parked
-- reference is still valid when it goes back.

-- ── 1 · Park the children ────────────────────────────────────────────────────

CREATE TABLE regions_rebuild_users (
    user_id   TEXT PRIMARY KEY,
    region_id INTEGER,
    street_id INTEGER
);

INSERT INTO regions_rebuild_users (user_id, region_id, street_id)
SELECT user_id, region_id, street_id FROM users
 WHERE region_id IS NOT NULL OR street_id IS NOT NULL;

UPDATE users SET region_id = NULL, street_id = NULL
 WHERE region_id IS NOT NULL OR street_id IS NOT NULL;

CREATE TABLE regions_rebuild_streets (
    id          INTEGER PRIMARY KEY,
    street_name TEXT NOT NULL,
    region_id   INTEGER NOT NULL,
    lat         REAL,
    lng         REAL
);

INSERT INTO regions_rebuild_streets (id, street_name, region_id, lat, lng)
SELECT id, street_name, region_id, lat, lng FROM streets;

DELETE FROM streets;

CREATE TABLE regions_rebuild_aliases (
    alias     TEXT PRIMARY KEY,
    region_id INTEGER NOT NULL
);

INSERT INTO regions_rebuild_aliases (alias, region_id)
SELECT alias, region_id FROM region_aliases;

DELETE FROM region_aliases;

-- ── 2 · Rebuild ──────────────────────────────────────────────────────────────

-- The self-FK names `regions_rebuild_new`, not `regions`: the new table must not
-- reference the old one, or the DROP below would count violations again. SQLite
-- rewrites references to a table when that table is renamed, so the clause reads
-- `REFERENCES regions(id)` once the rename at the end lands — the same property
-- 0015 relied on for users.street_id, verified there against local D1.
--
-- AUTOINCREMENT is kept for the reason 0015 kept it: it guarantees an id is
-- never reused, which is what users.region_id parked above depends on.
CREATE TABLE regions_rebuild_new (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    region_name   TEXT NOT NULL,
    lat           REAL,
    lng           REAL,
    settlement_id INTEGER REFERENCES regions_rebuild_new(id)
);

-- Two passes rather than one ordered INSERT … SELECT. A self-referencing FK is
-- checked per row, so a district copied before its settlement would fail, and
-- relying on the SELECT to yield parents first would make correctness depend on
-- an ordering SQLite does not promise. Copying the links separately needs no
-- ordering at all.
INSERT INTO regions_rebuild_new (id, region_name, lat, lng, settlement_id)
SELECT id, region_name, lat, lng, NULL FROM regions;

UPDATE regions_rebuild_new SET settlement_id = (
    SELECT r.settlement_id FROM regions r WHERE r.id = regions_rebuild_new.id
);

DROP TABLE regions;

ALTER TABLE regions_rebuild_new RENAME TO regions;

CREATE UNIQUE INDEX ux_regions_name_settlement
    ON regions(region_name, COALESCE(settlement_id, 0));

-- Recreated because it belonged to the dropped table (0016).
CREATE INDEX ix_regions_settlement ON regions(settlement_id);

-- ── 3 · Put the children back ────────────────────────────────────────────────

INSERT INTO streets (id, street_name, region_id, lat, lng)
SELECT id, street_name, region_id, lat, lng FROM regions_rebuild_streets;

INSERT INTO region_aliases (alias, region_id)
SELECT alias, region_id FROM regions_rebuild_aliases;

UPDATE users SET
    region_id = (SELECT b.region_id FROM regions_rebuild_users b WHERE b.user_id = users.user_id),
    street_id = (SELECT b.street_id FROM regions_rebuild_users b WHERE b.user_id = users.user_id)
 WHERE user_id IN (SELECT user_id FROM regions_rebuild_users);

DROP TABLE regions_rebuild_users;
DROP TABLE regions_rebuild_streets;
DROP TABLE regions_rebuild_aliases;

-- ── 4 · Retire the one bracket that was only ever a workaround ───────────────
--
-- "ж.к. Младост (Белослав)" was 0014 spelling a settlement into a name because
-- the schema had nowhere else to put it. The settlement now has somewhere: the
-- row's own settlement_id, which the province sweep fills from the Белослав
-- boundary the node was found inside. An UPDATE rather than a delete-and-reseed,
-- for 0014's reason — the id is what users point at.
--
-- Guarded both ways: only renamed when it would not collide, i.e. when Белослав
-- has no bare "ж.к. Младост" already. Re-running is then a no-op rather than a
-- UNIQUE violation.
--
-- The other three 0014 renames are deliberately left alone. "с. Аспарухово
-- (Дългопол)" and its two siblings are *settlements* whose bracket disambiguates
-- them from a Varna district that has no row of its own — dropping the bracket
-- would not add the missing district, it would only make the village harder to
-- find. "к.к. Чайка" is a corrected kind prefix, not a settlement, and is not a
-- bracket at all.
UPDATE regions SET region_name = 'ж.к. Младост'
 WHERE region_name = 'ж.к. Младост (Белослав)'
   AND NOT EXISTS (
       SELECT 1 FROM regions r
        WHERE r.region_name = 'ж.к. Младост'
          AND COALESCE(r.settlement_id, 0) = COALESCE(regions.settlement_id, 0)
   );
