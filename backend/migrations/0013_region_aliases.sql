-- Alternative written forms for a region (fix-plan D4).
--
-- One place, several names the sources actually use. The trigram matcher can
-- only reach spellings that share letters with the seeded name, and some do
-- not: епро writes "кв. Владислав Варненчик" for the district OSM (and our
-- seed) calls "кв. Владиславово". Comparing cores scores that pair 0.375 —
-- below the 0.40 the matcher needs to keep "Св.св.Константин и Елена" from
-- resolving to "Константиново" — so it matched nothing, and since a user's
-- region_id comes from the same table, the district was notified by neither
-- name.
--
-- Aliases are read as extra rows of `regions` carrying the target's id and
-- coordinates (see getRegions), so a matched alias resolves to the SAME
-- region_id as the canonical name. That is the point: a second regions row
-- would split the district's users in half instead of joining them.

CREATE TABLE region_aliases (
    alias     TEXT PRIMARY KEY,
    region_id INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE
);

CREATE INDEX ix_region_aliases_region ON region_aliases(region_id);
