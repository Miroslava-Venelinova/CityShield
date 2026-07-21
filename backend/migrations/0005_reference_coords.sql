-- Coordinates on the reference tables, populated by tools/osm-seed-builder.
--
-- Alert enrichment resolves a scraped location name against these tables with
-- a trigram match (src/core/fuzzy.ts) and then needs a point to pin on the map.
-- Carrying the centroid alongside the name lets a matched name skip Nominatim
-- entirely, which removes a 1,100 ms throttle wait plus an up-to-8 s request
-- from the ingest deadline budget on the common path.
--
-- Nullable on purpose: every row seeded before the OSM tool existed has no
-- coordinates, and those names keep falling back to Nominatim as before.

ALTER TABLE regions ADD COLUMN lat REAL;
ALTER TABLE regions ADD COLUMN lng REAL;
ALTER TABLE streets ADD COLUMN lat REAL;
ALTER TABLE streets ADD COLUMN lng REAL;
