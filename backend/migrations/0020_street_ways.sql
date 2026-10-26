-- Street geometry, stored, so the polygon builder never calls Overpass at ingest
-- time (docs/specification.md §1.9).
--
-- The builder used to fetch every block's ways from the public Overpass API in
-- the middle of an ingest tick. That endpoint answered 521 for two months: 1 of
-- 32 polygons built in 09.2026 and 0 of 15 in 10.2026, every other alert
-- falling back to a pin. The mirrors are no better — measured 26.10.2026, the
-- two that answered at all took 21 s and 33 s against a 15 s budget. Hosting
-- our own instance would mean keeping a machine on around the clock.
--
-- Street geometry changes on the scale of years, so it is seeded instead: the
-- province sweep in tools/osm-seed-builder already files every street under its
-- settlement, and now keeps each way's geometry too (backend/seeds/
-- street_ways.json, written into seed.sql by generate-seed.mjs).
--
-- One row per OSM way, because that is the unit the builder consumes — it merges
-- a street's lines itself (LineMerger) and extends each loose end. Keyed by the
-- street row rather than by name: the resolver has already picked the right
-- settlement's row (matchStreet), so the id IS the scope, and a same-named
-- street in another town cannot reach the geometry.
--
-- ON DELETE CASCADE because a way means nothing without its street: a reseed
-- deletes every street (seeds/reseed-pre.sql) and its ways go with it, and a
-- future rebuild of `streets` (see 0015 for why that needs care) cannot be
-- blocked by rows that are regenerated on every seed anyway.

CREATE TABLE street_ways (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    street_id INTEGER NOT NULL REFERENCES streets(id) ON DELETE CASCADE,
    coords    TEXT NOT NULL      -- JSON [[lon, lat], …] — one OSM way, ≥2 points
);

CREATE INDEX ix_street_ways_street ON street_ways(street_id);
